/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, EventMultiplexer } from 'vs/base/common/event';
import {
	ILocalExtension, IGalleryExtension, InstallExtensionEvent, DidInstallExtensionEvent, IExtensionIdentifier, DidUninstallExtensionEvent, IReportedExtension, IGalleryMetadata, IExtensionGalleryService, INSTALL_ERROR_NOT_SUPPORTED, InstallOptions
} from 'vs/platform/extensionManagement/common/extensionManagement';
import { IExtensionManagementServer, IExtensionManagementServerService, IWorkbenchExtensioManagementService } from 'vs/workbench/services/extensionManagement/common/extensionManagement';
import { ExtensionType, isLanguagePackExtension, IExtensionManifest } from 'vs/platform/extensions/common/extensions';
import { URI } from 'vs/base/common/uri';
import { Disposable } from 'vs/base/common/lifecycle';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { CancellationToken } from 'vs/base/common/cancellation';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { localize } from 'vs/nls';
import { prefersExecuteOnUI, canExecuteOnWorkspace, prefersExecuteOnWorkspace, canExecuteOnUI, prefersExecuteOnWeb, canExecuteOnWeb } from 'vs/workbench/services/extensions/common/extensionsUtil';
import { IProductService } from 'vs/platform/product/common/productService';
import { Schemas } from 'vs/base/common/network';
import { IDownloadService } from 'vs/platform/download/common/download';
import { flatten } from 'vs/base/common/arrays';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import Severity from 'vs/base/common/severity';
import { canceled } from 'vs/base/common/errors';
import { IUserDataAutoSyncEnablementService, IUserDataSyncResourceEnablementService, SyncResource } from 'vs/platform/userDataSync/common/userDataSync';

export class ExtensionManagementService extends Disposable implements IWorkbenchExtensioManagementService {

	declare readonly _serviceBrand: undefined;

	readonly onInstallExtension: Event<InstallExtensionEvent>;
	readonly onDidInstallExtension: Event<DidInstallExtensionEvent>;
	readonly onUninstallExtension: Event<IExtensionIdentifier>;
	readonly onDidUninstallExtension: Event<DidUninstallExtensionEvent>;

	protected readonly servers: IExtensionManagementServer[] = [];

	constructor(
		@IExtensionManagementServerService protected readonly extensionManagementServerService: IExtensionManagementServerService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IProductService protected readonly productService: IProductService,
		@IDownloadService protected readonly downloadService: IDownloadService,
		@IUserDataAutoSyncEnablementService private readonly userDataAutoSyncEnablementService: IUserDataAutoSyncEnablementService,
		@IUserDataSyncResourceEnablementService private readonly userDataSyncResourceEnablementService: IUserDataSyncResourceEnablementService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		if (this.extensionManagementServerService.localExtensionManagementServer) {
			this.servers.push(this.extensionManagementServerService.localExtensionManagementServer);
		}
		if (this.extensionManagementServerService.remoteExtensionManagementServer) {
			this.servers.push(this.extensionManagementServerService.remoteExtensionManagementServer);
		}
		if (this.extensionManagementServerService.webExtensionManagementServer) {
			this.servers.push(this.extensionManagementServerService.webExtensionManagementServer);
		}

		this.onInstallExtension = this._register(this.servers.reduce((emitter: EventMultiplexer<InstallExtensionEvent>, server) => { emitter.add(server.extensionManagementService.onInstallExtension); return emitter; }, new EventMultiplexer<InstallExtensionEvent>())).event;
		this.onDidInstallExtension = this._register(this.servers.reduce((emitter: EventMultiplexer<DidInstallExtensionEvent>, server) => { emitter.add(server.extensionManagementService.onDidInstallExtension); return emitter; }, new EventMultiplexer<DidInstallExtensionEvent>())).event;
		this.onUninstallExtension = this._register(this.servers.reduce((emitter: EventMultiplexer<IExtensionIdentifier>, server) => { emitter.add(server.extensionManagementService.onUninstallExtension); return emitter; }, new EventMultiplexer<IExtensionIdentifier>())).event;
		this.onDidUninstallExtension = this._register(this.servers.reduce((emitter: EventMultiplexer<DidUninstallExtensionEvent>, server) => { emitter.add(server.extensionManagementService.onDidUninstallExtension); return emitter; }, new EventMultiplexer<DidUninstallExtensionEvent>())).event;
	}

	async getInstalled(type?: ExtensionType): Promise<ILocalExtension[]> {
		const result = await Promise.all(this.servers.map(({ extensionManagementService }) => extensionManagementService.getInstalled(type)));
		return flatten(result);
	}

	async uninstall(extension: ILocalExtension): Promise<void> {
		const server = this.getServer(extension);
		if (!server) {
			return Promise.reject(`Invalid location ${extension.location.toString()}`);
		}
		if (this.servers.length > 1) {
			if (isLanguagePackExtension(extension.manifest)) {
				return this.uninstallEverywhere(extension);
			}
			return this.uninstallInServer(extension, server);
		}
		return server.extensionManagementService.uninstall(extension);
	}

	private async uninstallEverywhere(extension: ILocalExtension): Promise<void> {
		const server = this.getServer(extension);
		if (!server) {
			return Promise.reject(`Invalid location ${extension.location.toString()}`);
		}
		const promise = server.extensionManagementService.uninstall(extension);
		const otherServers: IExtensionManagementServer[] = this.servers.filter(s => s !== server);
		if (otherServers.length) {
			for (const otherServer of otherServers) {
				const installed = await otherServer.extensionManagementService.getInstalled();
				extension = installed.filter(i => !i.isBuiltin && areSameExtensions(i.identifier, extension.identifier))[0];
				if (extension) {
					await otherServer.extensionManagementService.uninstall(extension);
				}
			}
		}
		return promise;
	}

	private async uninstallInServer(extension: ILocalExtension, server: IExtensionManagementServer, force?: boolean): Promise<void> {
		if (server === this.extensionManagementServerService.localExtensionManagementServer) {
			const installedExtensions = await this.extensionManagementServerService.remoteExtensionManagementServer!.extensionManagementService.getInstalled(ExtensionType.User);
			const dependentNonUIExtensions = installedExtensions.filter(i => !prefersExecuteOnUI(i.manifest, this.productService, this.configurationService)
				&& i.manifest.extensionDependencies && i.manifest.extensionDependencies.some(id => areSameExtensions({ id }, extension.identifier)));
			if (dependentNonUIExtensions.length) {
				return Promise.reject(new Error(this.getDependentsErrorMessage(extension, dependentNonUIExtensions)));
			}
		}
		return server.extensionManagementService.uninstall(extension, force);
	}

	private getDependentsErrorMessage(extension: ILocalExtension, dependents: ILocalExtension[]): string {
		if (dependents.length === 1) {
			return localize('singleDependentError', "Cannot uninstall extension '{0}'. Extension '{1}' depends on this.",
				extension.manifest.displayName || extension.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name);
		}
		if (dependents.length === 2) {
			return localize('twoDependentsError', "Cannot uninstall extension '{0}'. Extensions '{1}' and '{2}' depend on this.",
				extension.manifest.displayName || extension.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name, dependents[1].manifest.displayName || dependents[1].manifest.name);
		}
		return localize('multipleDependentsError', "Cannot uninstall extension '{0}'. Extensions '{1}', '{2}' and others depend on this.",
			extension.manifest.displayName || extension.manifest.name, dependents[0].manifest.displayName || dependents[0].manifest.name, dependents[1].manifest.displayName || dependents[1].manifest.name);

	}

	reinstallFromGallery(extension: ILocalExtension): Promise<void> {
		const server = this.getServer(extension);
		if (server) {
			return server.extensionManagementService.reinstallFromGallery(extension);
		}
		return Promise.reject(`Invalid location ${extension.location.toString()}`);
	}

	updateMetadata(extension: ILocalExtension, metadata: IGalleryMetadata): Promise<ILocalExtension> {
		const server = this.getServer(extension);
		if (server) {
			return server.extensionManagementService.updateMetadata(extension, metadata);
		}
		return Promise.reject(`Invalid location ${extension.location.toString()}`);
	}

	updateExtensionScope(extension: ILocalExtension, isMachineScoped: boolean): Promise<ILocalExtension> {
		const server = this.getServer(extension);
		if (server) {
			return server.extensionManagementService.updateExtensionScope(extension, isMachineScoped);
		}
		return Promise.reject(`Invalid location ${extension.location.toString()}`);
	}

	zip(extension: ILocalExtension): Promise<URI> {
		const server = this.getServer(extension);
		if (server) {
			return server.extensionManagementService.zip(extension);
		}
		return Promise.reject(`Invalid location ${extension.location.toString()}`);
	}

	unzip(zipLocation: URI): Promise<IExtensionIdentifier> {
		return Promise.all(this.servers
			// Filter out web server
			.filter(server => server !== this.extensionManagementServerService.webExtensionManagementServer)
			.map(({ extensionManagementService }) => extensionManagementService.unzip(zipLocation))).then(([extensionIdentifier]) => extensionIdentifier);
	}

	async install(vsix: URI): Promise<ILocalExtension> {
		if (this.extensionManagementServerService.localExtensionManagementServer && this.extensionManagementServerService.remoteExtensionManagementServer) {
			const manifest = await this.getManifest(vsix);
			if (isLanguagePackExtension(manifest)) {
				// Install on both servers
				const [local] = await Promise.all([this.extensionManagementServerService.localExtensionManagementServer, this.extensionManagementServerService.remoteExtensionManagementServer].map(server => this.installVSIX(vsix, server)));
				return local;
			}
			if (prefersExecuteOnUI(manifest, this.productService, this.configurationService)) {
				// Install only on local server
				return this.installVSIX(vsix, this.extensionManagementServerService.localExtensionManagementServer);
			}
			// Install only on remote server
			return this.installVSIX(vsix, this.extensionManagementServerService.remoteExtensionManagementServer);
		}
		if (this.extensionManagementServerService.localExtensionManagementServer) {
			return this.installVSIX(vsix, this.extensionManagementServerService.localExtensionManagementServer);
		}
		if (this.extensionManagementServerService.remoteExtensionManagementServer) {
			return this.installVSIX(vsix, this.extensionManagementServerService.remoteExtensionManagementServer);
		}
		return Promise.reject('No Servers to Install');
	}

	protected installVSIX(vsix: URI, server: IExtensionManagementServer): Promise<ILocalExtension> {
		return server.extensionManagementService.install(vsix);
	}

	getManifest(vsix: URI): Promise<IExtensionManifest> {
		if (vsix.scheme === Schemas.file && this.extensionManagementServerService.localExtensionManagementServer) {
			return this.extensionManagementServerService.localExtensionManagementServer.extensionManagementService.getManifest(vsix);
		}
		if (vsix.scheme === Schemas.vscodeRemote && this.extensionManagementServerService.remoteExtensionManagementServer) {
			return this.extensionManagementServerService.remoteExtensionManagementServer.extensionManagementService.getManifest(vsix);
		}
		return Promise.reject('No Servers');
	}

	async canInstall(gallery: IGalleryExtension): Promise<boolean> {
		for (const server of this.servers) {
			if (await server.extensionManagementService.canInstall(gallery)) {
				return true;
			}
		}
		return false;
	}

	async updateFromGallery(gallery: IGalleryExtension, extension: ILocalExtension): Promise<ILocalExtension> {
		const server = this.getServer(extension);
		if (!server) {
			return Promise.reject(`Invalid location ${extension.location.toString()}`);
		}

		const servers: IExtensionManagementServer[] = [];

		// Update Language pack on all servers
		if (isLanguagePackExtension(extension.manifest)) {
			servers.push(...this.servers);
		} else {
			servers.push(server);
		}

		return Promise.all(servers.map(server => server.extensionManagementService.installFromGallery(gallery))).then(([local]) => local);
	}

	async installExtensions(extensions: IGalleryExtension[], installOptions?: InstallOptions): Promise<ILocalExtension[]> {
		if (!installOptions) {
			const isMachineScoped = await this.hasToFlagExtensionsMachineScoped(extensions);
			installOptions = { isMachineScoped, isBuiltin: false };
		}
		return Promise.all(extensions.map(extension => this.installFromGallery(extension, installOptions)));
	}

	async installFromGallery(gallery: IGalleryExtension, installOptions?: InstallOptions): Promise<ILocalExtension> {

		const manifest = await this.extensionGalleryService.getManifest(gallery, CancellationToken.None);
		if (!manifest) {
			return Promise.reject(localize('Manifest is not found', "Installing Extension {0} failed: Manifest is not found.", gallery.displayName || gallery.name));
		}

		const servers: IExtensionManagementServer[] = [];

		// Install Language pack on all servers
		if (isLanguagePackExtension(manifest)) {
			servers.push(...this.servers);
		} else {
			const server = this.getExtensionManagementServerToInstall(manifest);
			if (server) {
				servers.push(server);
			}
		}

		if (servers.length) {
			if (!installOptions) {
				const isMachineScoped = await this.hasToFlagExtensionsMachineScoped([gallery]);
				installOptions = { isMachineScoped, isBuiltin: false };
			}
			if (!installOptions.isMachineScoped) {
				if (this.extensionManagementServerService.localExtensionManagementServer && !servers.includes(this.extensionManagementServerService.localExtensionManagementServer)) {
					servers.push(this.extensionManagementServerService.localExtensionManagementServer);
				}
			}
			return Promise.all(servers.map(server => server.extensionManagementService.installFromGallery(gallery, installOptions))).then(([local]) => local);
		}

		if (this.extensionManagementServerService.remoteExtensionManagementServer) {
			const error = new Error(localize('cannot be installed', "Cannot install '{0}' because this extension has defined that it cannot run on the remote server.", gallery.displayName || gallery.name));
			error.name = INSTALL_ERROR_NOT_SUPPORTED;
			return Promise.reject(error);
		}

		const error = new Error(localize('cannot be installed on web', "Cannot install '{0}' because this extension has defined that it cannot run on the web server.", gallery.displayName || gallery.name));
		error.name = INSTALL_ERROR_NOT_SUPPORTED;
		return Promise.reject(error);
	}

	private getExtensionManagementServerToInstall(manifest: IExtensionManifest): IExtensionManagementServer | undefined {

		// Only local server
		if (this.servers.length === 1 && this.extensionManagementServerService.localExtensionManagementServer) {
			return this.extensionManagementServerService.localExtensionManagementServer;
		}

		// 1. Install on preferred location

		// Install UI preferred extension on local server
		if (prefersExecuteOnUI(manifest, this.productService, this.configurationService) && this.extensionManagementServerService.localExtensionManagementServer) {
			return this.extensionManagementServerService.localExtensionManagementServer;
		}
		// Install Workspace preferred extension on remote server
		if (prefersExecuteOnWorkspace(manifest, this.productService, this.configurationService) && this.extensionManagementServerService.remoteExtensionManagementServer) {
			return this.extensionManagementServerService.remoteExtensionManagementServer;
		}
		// Install Web preferred extension on web server
		if (prefersExecuteOnWeb(manifest, this.productService, this.configurationService) && this.extensionManagementServerService.webExtensionManagementServer) {
			return this.extensionManagementServerService.webExtensionManagementServer;
		}

		// 2. Install on supported location

		// Install UI supported extension on local server
		if (canExecuteOnUI(manifest, this.productService, this.configurationService) && this.extensionManagementServerService.localExtensionManagementServer) {
			return this.extensionManagementServerService.localExtensionManagementServer;
		}
		// Install Workspace supported extension on remote server
		if (canExecuteOnWorkspace(manifest, this.productService, this.configurationService) && this.extensionManagementServerService.remoteExtensionManagementServer) {
			return this.extensionManagementServerService.remoteExtensionManagementServer;
		}
		// Install Web supported extension on web server
		if (canExecuteOnWeb(manifest, this.productService, this.configurationService) && this.extensionManagementServerService.webExtensionManagementServer) {
			return this.extensionManagementServerService.webExtensionManagementServer;
		}

		return undefined;
	}

	private async hasToFlagExtensionsMachineScoped(extensions: IGalleryExtension[]): Promise<boolean> {
		if (!this.userDataAutoSyncEnablementService.isEnabled() || !this.userDataSyncResourceEnablementService.isResourceEnabled(SyncResource.Extensions)) {
			return false;
		}
		const result = await this.dialogService.show(
			Severity.Info,
			extensions.length === 1 ? localize('install extension', "Install Extension") : localize('install extensions', "Install Extensions"),
			[
				localize('install', "Install"),
				localize('install and do no sync', "Install (Do not sync)"),
				localize('cancel', "Cancel"),
			],
			{
				cancelId: 2,
				detail: extensions.length === 1
					? localize('install single extension', "Would you like to install and synchronize '{0}' extension across your devices?", extensions[0].displayName)
					: localize('install multiple extensions', "Would you like to install and synchronize extensions across your devices?")
			}
		);
		switch (result.choice) {
			case 0:
				return false;
			case 1:
				return true;
		}
		throw canceled();
	}

	getExtensionsReport(): Promise<IReportedExtension[]> {
		if (this.extensionManagementServerService.localExtensionManagementServer) {
			return this.extensionManagementServerService.localExtensionManagementServer.extensionManagementService.getExtensionsReport();
		}
		if (this.extensionManagementServerService.remoteExtensionManagementServer) {
			return this.extensionManagementServerService.remoteExtensionManagementServer.extensionManagementService.getExtensionsReport();
		}
		return Promise.resolve([]);
	}

	private getServer(extension: ILocalExtension): IExtensionManagementServer | null {
		return this.extensionManagementServerService.getExtensionManagementServer(extension);
	}
}
