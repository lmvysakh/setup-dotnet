import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import fs from 'fs';
import * as fspromises from 'fs/promises';
import semver from 'semver';
import * as auth from '../src/authutil';

import * as setup from '../src/setup-dotnet';
import * as installer from '../src/installer';
import {DotnetCoreInstaller, DotnetInstallDir} from '../src/installer';
import * as cacheUtils from '../src/cache-utils';
import * as cacheRestore from '../src/cache-restore';

describe('setup-dotnet tests', () => {
  const inputs = {} as any;

  // Mock file system operations
  jest.spyOn(exec, 'getExecOutput').mockResolvedValue({
    exitCode: 0,
    stdout: 'Installed version 8.0.100',
    stderr: ''
  });
  jest.spyOn(io, 'which').mockResolvedValue('PathToShell' as any);
  jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});

  const getInputSpy = jest.spyOn(core, 'getInput');
  const getMultilineInputSpy = jest.spyOn(core, 'getMultilineInput');
  const getBooleanInputSpy = jest.spyOn(core, 'getBooleanInput');
  const setFailedSpy = jest.spyOn(core, 'setFailed');
  const warningSpy = jest.spyOn(core, 'warning');
  const debugSpy = jest.spyOn(core, 'debug');
  const infoSpy = jest.spyOn(core, 'info');
  const setOutputSpy = jest.spyOn(core, 'setOutput');

  const existsSyncSpy = jest.spyOn(fs, 'existsSync');

  const maxSatisfyingSpy = jest.spyOn(semver, 'maxSatisfying');

  const installDotnetSpy = jest.spyOn(
    DotnetCoreInstaller.prototype,
    'installDotnet'
  );

  const isCacheFeatureAvailableSpy = jest.spyOn(
    cacheUtils,
    'isCacheFeatureAvailable'
  );
  const restoreCacheSpy = jest.spyOn(cacheRestore, 'restoreCache');
  const configAuthenticationSpy = jest.spyOn(auth, 'configAuthentication');
  const addToPathOriginal = DotnetInstallDir.addToPath;

  describe('run() tests', () => {
    beforeEach(() => {
      DotnetInstallDir.addToPath = jest.fn();
      getMultilineInputSpy.mockImplementation(input => {
        const value = inputs[input as string];
        return Array.isArray(value) ? value : value ? [value] : [];
      });
      getInputSpy.mockImplementation(input => {
        const value = inputs[input as string];
        return Array.isArray(value) ? value.join('\n') : value || '';
      });
      getBooleanInputSpy.mockImplementation(input => inputs[input as string]);
    });

    afterEach(() => {
      DotnetInstallDir.addToPath = addToPathOriginal;
      jest.clearAllMocks();
      jest.resetAllMocks();
    });

    it('should fail the action if global-json-file input is present, but the file does not exist in the file system', async () => {
      inputs['global-json-file'] = 'fictitious.json';
      inputs['dotnet-version'] = [];

      const expectedErrorMessage = `The specified global.json file '${inputs['global-json-file']}' does not exist`;

      await setup.run();
      expect(setFailedSpy).toHaveBeenCalledWith(expectedErrorMessage);
    });

    test(`if 'dotnet-version' and 'global-json-file' inputs aren't present, should log into debug output, try to find global.json in the repo root, fail and log message into info output`, async () => {
      inputs['global-json-file'] = '';
      inputs['dotnet-version'] = [];

      maxSatisfyingSpy.mockImplementation(() => null);
      setOutputSpy.mockImplementation(() => {});

      const expectedDebugMessage =
        'No version found, trying to find version from global.json';
      const expectedInfoMessage = `The global.json wasn't found in the root directory. No .NET version will be installed.`;

      await setup.run();

      expect(debugSpy).toHaveBeenCalledWith(expectedDebugMessage);
      expect(existsSyncSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expectedInfoMessage);
    });

    it('should fail the action if quality is supplied but its value is not supported', async () => {
      inputs['global-json-file'] = '';
      inputs['dotnet-version'] = '10.0';
      inputs['dotnet-quality'] = 'fictitiousQuality';

      const expectedErrorMessage = `Value '${inputs['dotnet-quality']}' is not supported for the 'dotnet-quality' option. Supported values are: daily, signed, validated, preview, ga.`;

      await setup.run();
      expect(setFailedSpy).toHaveBeenCalledWith(expectedErrorMessage);
    });

    it('should call installDotnet() multiple times if dotnet-version multiline input is provided (legacy, default arch)', async () => {
      // Mock installDotnetVersions to record the calls
      const callHistory: any[] = [];
      const installDotnetVersionsSpy = jest
        .spyOn(installer, 'installDotnetVersions')
        .mockImplementation(async (versionArchEntries: any[]) => {
          callHistory.push(...versionArchEntries);
          return versionArchEntries.map(
            entry => `${entry.version} (${entry.architecture})`
          );
        });

      inputs['global-json-file'] = '';
      inputs['dotnet-version'] = ['9.0', '10.0'];
      inputs['dotnet-quality'] = '';
      inputs['architecture'] = 'arm64';

      await setup.run();
      expect(callHistory).toHaveLength(2);
      expect(callHistory.map(i => i.architecture)).toEqual(['arm64', 'arm64']);

      installDotnetVersionsSpy.mockRestore();
    });

    it('should call DotnetCoreInstaller with explicit arch from new syntax', async () => {
      // Mock installDotnetVersions to record the calls
      const callHistory: any[] = [];
      const installDotnetVersionsSpy = jest
        .spyOn(installer, 'installDotnetVersions')
        .mockImplementation(async (versionArchEntries: any[]) => {
          callHistory.push(...versionArchEntries);
          return versionArchEntries.map(
            entry => `${entry.version} (${entry.architecture})`
          );
        });

      inputs['global-json-file'] = '';
      inputs['dotnet-version'] = [
        'version: 8.0.x, arch: x64',
        'version: 8.0.x, arch: arm64'
      ];
      inputs['dotnet-quality'] = '';
      inputs['architecture'] = 'arm64';

      await setup.run();
      // Make sure the arch is set per line as expected (even if default arch differs)
      expect(callHistory).toHaveLength(2);
      expect(callHistory[0].architecture).toBe('x64');
      expect(callHistory[1].architecture).toBe('arm64');

      installDotnetVersionsSpy.mockRestore();
    });

    it('should call DotnetCoreInstaller with legacy and new syntax mixed and use correct arch', async () => {
      // Mock installDotnetVersions to record the calls
      const callHistory: any[] = [];
      const installDotnetVersionsSpy = jest
        .spyOn(installer, 'installDotnetVersions')
        .mockImplementation(async (versionArchEntries: any[]) => {
          callHistory.push(...versionArchEntries);
          return versionArchEntries.map(
            entry => `${entry.version} (${entry.architecture})`
          );
        });

      inputs['global-json-file'] = '';
      inputs['dotnet-version'] = ['6.0.x', 'version: 8.0.x, arch: arm64'];
      inputs['dotnet-quality'] = '';
      inputs['architecture'] = 'x64';

      await setup.run();
      expect(callHistory).toHaveLength(2);
      expect(callHistory[0].version).toBe('6.0.x');
      expect(callHistory[0].architecture).toBe('x64');
      expect(callHistory[1].version).toBe('8.0.x');
      expect(callHistory[1].architecture).toBe('arm64');

      installDotnetVersionsSpy.mockRestore();
    });

    it('should call addToPath() after installation complete', async () => {
      inputs['global-json-file'] = '';
      inputs['dotnet-version'] = ['9.0', '10.0'];
      inputs['dotnet-quality'] = '';

      installDotnetSpy.mockImplementation(() => Promise.resolve(''));

      await setup.run();
      expect(DotnetInstallDir.addToPath).toHaveBeenCalledTimes(1);
    });

    it('should call auth.configAuthentication() if source-url input is provided', async () => {
      inputs['global-json-file'] = '';
      inputs['dotnet-version'] = [];
      inputs['dotnet-quality'] = '';
      inputs['source-url'] = 'fictitious.source.url';

      configAuthenticationSpy.mockImplementation(() => {});

      await setup.run();
      expect(configAuthenticationSpy).toHaveBeenCalledWith(
        inputs['source-url'],
        ''
      );
    });

    it('should call auth.configAuthentication() with proper parameters if source-url and config-file inputs are provided', async () => {
      inputs['global-json-file'] = '';
      inputs['dotnet-version'] = [];
      inputs['dotnet-quality'] = '';
      inputs['source-url'] = 'fictitious.source.url';
      inputs['config-file'] = 'fictitious.path';

      configAuthenticationSpy.mockImplementation(() => {});
      setOutputSpy.mockImplementation(() => {});

      await setup.run();
      expect(configAuthenticationSpy).toHaveBeenCalledWith(
        inputs['source-url'],
        inputs['config-file']
      );
    });

    it('should call setOutput() after installation complete successfully', async () => {
      inputs['dotnet-version'] = ['10.0.101'];

      installDotnetSpy.mockImplementation(() =>
        Promise.resolve(`${inputs['dotnet-version']}`)
      );

      await setup.run();
      expect(DotnetInstallDir.addToPath).toHaveBeenCalledTimes(1);
    });

    it(`shouldn't call setOutput() if parsing dotnet-installer logs failed`, async () => {
      inputs['dotnet-version'] = ['10.0.101'];
      const warningMessage = `Failed to output the installed version of .NET. The 'dotnet-version' output will not be set.`;

      // Mock installDotnetVersions to return null (simulating parsing failure)
      const installDotnetVersionsSpy = jest
        .spyOn(installer, 'installDotnetVersions')
        .mockResolvedValue([null]);

      await setup.run();
      expect(warningSpy).toHaveBeenCalledWith(warningMessage);
      expect(setOutputSpy).not.toHaveBeenCalled();

      installDotnetVersionsSpy.mockRestore();
    });

    it(`shouldn't call setOutput() if actions didn't install .NET`, async () => {
      inputs['dotnet-version'] = [];
      const warningMessage = `The 'dotnet-version' output will not be set.`;

      await setup.run();

      expect(infoSpy).toHaveBeenCalledWith(warningMessage);
      expect(setOutputSpy).not.toHaveBeenCalled();
    });

    it(`should get 'cache-dependency-path' and call restoreCache() if input cache is set to true and cache feature is available`, async () => {
      inputs['dotnet-version'] = ['10.0.101'];
      inputs['dotnet-quality'] = '';
      inputs['cache'] = true;
      inputs['cache-dependency-path'] = 'fictitious.package.lock.json';

      installDotnetSpy.mockImplementation(() => Promise.resolve(''));

      isCacheFeatureAvailableSpy.mockImplementation(() => true);
      restoreCacheSpy.mockImplementation(() => Promise.resolve());

      await setup.run();
      expect(isCacheFeatureAvailableSpy).toHaveBeenCalledTimes(1);
      expect(restoreCacheSpy).toHaveBeenCalledWith(
        inputs['cache-dependency-path']
      );
    });

    it(`shouldn't call restoreCache() if input cache isn't set to true`, async () => {
      inputs['dotnet-version'] = ['10.0.101'];
      inputs['dotnet-quality'] = '';
      inputs['cache'] = false;

      installDotnetSpy.mockImplementation(() => Promise.resolve(''));

      isCacheFeatureAvailableSpy.mockImplementation(() => true);
      restoreCacheSpy.mockImplementation(() => Promise.resolve());

      await setup.run();
      expect(restoreCacheSpy).not.toHaveBeenCalled();
    });

    it(`shouldn't call restoreCache() if cache feature isn't available`, async () => {
      inputs['dotnet-version'] = ['10.0.101'];
      inputs['dotnet-quality'] = '';
      inputs['cache'] = true;

      installDotnetSpy.mockImplementation(() => Promise.resolve(''));

      isCacheFeatureAvailableSpy.mockImplementation(() => false);
      restoreCacheSpy.mockImplementation(() => Promise.resolve());

      await setup.run();
      expect(restoreCacheSpy).not.toHaveBeenCalled();
    });
  });
});
