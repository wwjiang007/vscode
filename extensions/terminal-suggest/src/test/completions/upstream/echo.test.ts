/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import { testPaths, type ISuiteSpec } from '../../helpers';
import echoSpec from '../../../completions/upstream/echo';

const allOptions = [
	'-E',
	'-e',
	'-n',
];

export const echoTestSuiteSpec: ISuiteSpec = {
	name: 'echo',
	completionSpecs: echoSpec,
	availableCommands: 'echo',
	testSpecs: [
		// Empty input
		{ input: '|', expectedCompletions: ['echo'], expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },

		// Typing the command
		{ input: 'e|', expectedCompletions: ['echo'], expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		{ input: 'ec|', expectedCompletions: ['echo'], expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		{ input: 'ech|', expectedCompletions: ['echo'], expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		{ input: 'echo|', expectedCompletions: ['echo'], expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },

		// Basic options
		{ input: 'echo |', expectedCompletions: allOptions },

		// Duplicate option
		// TODO: Duplicate options should not be presented https://github.com/microsoft/vscode/issues/239607
		// { input: 'echo -e -|', expectedCompletions: removeArrayEntries(allOptions, '-e') },
		// { input: 'echo -e -E -|', expectedCompletions: removeArrayEntries(allOptions, '-e', '-E') },
	]
};
