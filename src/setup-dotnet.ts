import * as core from '@actions/core';
import {DotnetCoreInstaller, DotnetInstallDir} from './installer';
import * as fs from 'fs';
import path from 'path';
import semver from 'semver';
import * as auth from './authutil';
import {isCacheFeatureAvailable} from './cache-utils';
import {restoreCache} from './cache-restore';
import {Outputs} from './constants';
import JSON5 from 'json5';
import YAML from 'yaml';

const qualityOptions = [
  'daily',
  'signed',
  'validated',
  'preview',
  'ga'
] as const;

export type QualityOptions = (typeof qualityOptions)[number];

type DotnetInstallDescriptor = {
  version: string;
  arch?: string;
  quality?: QualityOptions;
};

export async function run() {
  try {
    // ---------- NEW LOGIC: Parse dotnet input for multi-arch mode ----------
    const dotnetInput = core.getInput('dotnet');
    let installDescriptors: DotnetInstallDescriptor[] = [];

    if (dotnetInput && dotnetInput.trim()) {
      try {
        // Try to parse as YAML (or JSON fallback if single line)
        let parsed = YAML.parse(dotnetInput);
        if (!Array.isArray(parsed)) parsed = [parsed];
        installDescriptors = parsed.map(d => ({
          version: d.version,
          arch: d.arch,
          quality: d.quality
        }));
      } catch (err: any) {
        core.setFailed(
          `Failed to parse 'dotnet' input as YAML/array: ${err.message}`
        );
        return;
      }
      // Validate descriptors
      installDescriptors = installDescriptors.filter(
        d => d.version && typeof d.version === 'string'
      );
      if (!installDescriptors.length) {
        core.setFailed("No valid .NET SDK definitions found in 'dotnet' input.");
        return;
      }
    }

    // ---------- LEGACY LOGIC: Collect versions if not using multi-arch input ----------
    if (!installDescriptors.length) {
      const versions = core.getMultilineInput('dotnet-version');
      const globalJsonFileInput = core.getInput('global-json-file');
      if (globalJsonFileInput) {
        const globalJsonPath = path.resolve(process.cwd(), globalJsonFileInput);
        if (!fs.existsSync(globalJsonPath)) {
          throw new Error(
            `The specified global.json file '${globalJsonFileInput}' does not exist`
          );
        }
        versions.push(getVersionFromGlobalJson(globalJsonPath));
      }
      if (!versions.length) {
        // Try to fall back to global.json
        core.debug('No version found, trying to find version from global.json');
        const globalJsonPath = path.join(process.cwd(), 'global.json');
        if (fs.existsSync(globalJsonPath)) {
          versions.push(getVersionFromGlobalJson(globalJsonPath));
        } else {
          core.info(
            `The global.json wasn't found in the root directory. No .NET version will be installed.`
          );
        }
      }
      const quality = core.getInput('dotnet-quality') as QualityOptions;
      if (
        quality &&
        !qualityOptions.includes(quality)
      ) {
        throw new Error(
          `Value '${quality}' is not supported for the 'dotnet-quality' option. Supported values are: daily, signed, validated, preview, ga.`
        );
      }
      installDescriptors = Array.from(new Set(versions.filter(Boolean))).map(v => ({
        version: v,
        quality
      }));
    }

    // ---------- Installation loop ----------
    const installedDotnetVersions: (string | null)[] = [];
    for (const descriptor of installDescriptors) {
      const version = descriptor.version;
      const arch = descriptor.arch || process.arch;
      const quality: QualityOptions | undefined = descriptor.quality;

      // Quality validation (from legacy logic)
      if (quality && !qualityOptions.includes(quality)) {
        throw new Error(
          `Value '${quality}' is not supported for the 'dotnet-quality' option. Supported values are: daily, signed, validated, preview, ga.`
        );
      }

      core.startGroup(
        `Installing .NET SDK version ${version} (${arch})${quality ? `, quality: ${quality}` : ''}`
      );
      // NOTE: You must update the DotnetCoreInstaller/installDotnet logic to accept arch!
      const dotnetInstaller = new DotnetCoreInstaller(version, quality, arch);
      const installedVersion = await dotnetInstaller.installDotnet();
      installedDotnetVersions.push(installedVersion);
      core.endGroup();
    }
    DotnetInstallDir.addToPath();

    // ---------- Auth and EXTRAS ----------
    const sourceUrl: string = core.getInput('source-url');
    const configFile: string = core.getInput('config-file');
    if (sourceUrl) {
      auth.configAuthentication(sourceUrl, configFile);
    }

    // ---------- Outputs ----------
    outputInstalledVersion(installedDotnetVersions, core.getInput('global-json-file'));

    // ---------- Caching ----------
    if (core.getBooleanInput('cache') && isCacheFeatureAvailable()) {
      const cacheDependencyPath = core.getInput('cache-dependency-path');
      await restoreCache(cacheDependencyPath);
    }

    // ---------- CSL Matchers ----------
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
    const versionToOutput = installedVersions.at(-1); // last-installed version
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