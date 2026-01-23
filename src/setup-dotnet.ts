import * as core from '@actions/core';
import {
  parseVersionArchInput,
  installDotnetVersions,
  DotnetInstallDir,
  VersionArchEntry
} from './installer';
import * as fs from 'fs';
import path from 'path';
import semver from 'semver';
import * as auth from './authutil';
import {isCacheFeatureAvailable} from './cache-utils';
import {restoreCache} from './cache-restore';
import {Outputs} from './constants';
import JSON5 from 'json5';

const qualityOptions = [
  'daily',
  'signed',
  'validated',
  'preview',
  'ga'
] as const;

export type QualityOptions = (typeof qualityOptions)[number];

export async function run() {
  try {
    const installedDotnetVersions: (string | null)[] = [];
    const defaultArchitecture = core.getInput('architecture') || 'x64';

    //
    // dotnet-version may be specified using legacy (string or multiline) or new multi-arch syntax.
    // Eventually, need a flat string for advanced parsing.
    //
    let dotnetVersionInput = '';
    const multiline = core.getMultilineInput('dotnet-version');
    if (multiline.length > 1) {
      dotnetVersionInput = multiline.join('\n');
    } else {
      dotnetVersionInput = core.getInput('dotnet-version');
    }

    // Handle global.json file if present
    const globalJsonFileInput = core.getInput('global-json-file');
    if (globalJsonFileInput) {
      const globalJsonPath = path.resolve(process.cwd(), globalJsonFileInput);
      if (!fs.existsSync(globalJsonPath)) {
        throw new Error(
          `The specified global.json file '${globalJsonFileInput}' does not exist`
        );
      }
      const globalVersion = getVersionFromGlobalJson(globalJsonPath);
      if (globalVersion) {
        dotnetVersionInput +=
          (dotnetVersionInput.length ? '\n' : '') + globalVersion;
      }
    }

    // Try global.json fallback if nothing provided
    if (!dotnetVersionInput || dotnetVersionInput.trim().length === 0) {
      core.debug('No version found, trying to find version from global.json');
      const globalJsonPath = path.join(process.cwd(), 'global.json');
      if (fs.existsSync(globalJsonPath)) {
        const globalVersion = getVersionFromGlobalJson(globalJsonPath);
        if (globalVersion) {
          dotnetVersionInput = globalVersion;
        }
      } else {
        core.info(
          `The global.json wasn't found in the root directory. No .NET version will be installed.`
        );
      }
    }

    // Main multi-arch parsing/installation block
    if (dotnetVersionInput && dotnetVersionInput.trim().length > 0) {
      const quality = core.getInput('dotnet-quality') as QualityOptions;
      if (quality && !qualityOptions.includes(quality)) {
        throw new Error(
          `Value '${quality}' is not supported for the 'dotnet-quality' option. Supported values are: daily, signed, validated, preview, ga.`
        );
      }

      // Only parse lines that aren't empty
      const versionArchEntries: VersionArchEntry[] = parseVersionArchInput(
        dotnetVersionInput,
        defaultArchitecture
      );

      // Install each distinct version/arch combo
      const installedVersionInfo = await installDotnetVersions(
        versionArchEntries,
        quality
      );
      installedVersionInfo.forEach(i => installedDotnetVersions.push(i));
      DotnetInstallDir.addToPath();
    }

    const sourceUrl: string = core.getInput('source-url');
    const configFile: string = core.getInput('config-file');
    if (sourceUrl) {
      auth.configAuthentication(sourceUrl, configFile);
    }

    outputInstalledVersion(installedDotnetVersions, globalJsonFileInput);

    if (core.getBooleanInput('cache') && isCacheFeatureAvailable()) {
      const cacheDependencyPath = core.getInput('cache-dependency-path');
      await restoreCache(cacheDependencyPath);
    }

    const matchersPath = path.join(__dirname, '..', '..', '.github');
    core.info(`##[add-matcher]${path.join(matchersPath, 'csc.json')}`);
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

function getVersionFromGlobalJson(globalJsonPath: string): string {
  let version = '';
  const globalJson = JSON5.parse(
    // .trim() is necessary to strip BOM https://github.com/nodejs/node/issues/20649
    fs.readFileSync(globalJsonPath, {encoding: 'utf8'}).trim(),
    // is necessary as JSON5 supports wider variety of options for numbers: https://www.npmjs.com/package/json5#numbers
    (key, value) => {
      if (key === 'version' || key === 'rollForward') return String(value);
      return value;
    }
  );
  if (globalJson.sdk && globalJson.sdk.version) {
    version = globalJson.sdk.version;
    const rollForward = globalJson.sdk.rollForward;
    if (rollForward && rollForward === 'latestFeature') {
      const [major, minor] = version.split('.');
      version = `${major}.${minor}`;
    }
  }
  return version;
}

function outputInstalledVersion(
  installedVersions: (string | null)[],
  globalJsonFileInput: string
): void {
  if (!installedVersions.length) {
    core.info(`The '${Outputs.DotnetVersion}' output will not be set.`);
    return;
  }

  if (installedVersions.includes(null)) {
    core.warning(
      `Failed to output the installed version of .NET. The '${Outputs.DotnetVersion}' output will not be set.`
    );
    return;
  }

  if (globalJsonFileInput) {
    const versionToOutput = installedVersions.at(-1); // .NET SDK version parsed from the global.json file is installed last
    core.setOutput(Outputs.DotnetVersion, versionToOutput);
    return;
  }

  const versionToOutput = semver.maxSatisfying(
    installedVersions as string[],
    '*',
    {
      includePrerelease: true
    }
  );

  core.setOutput(Outputs.DotnetVersion, versionToOutput);
}

run();
