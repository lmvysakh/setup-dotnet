// Load tempDirectory before it gets wiped by tool-cache
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as hc from '@actions/http-client';
import {chmodSync} from 'fs';
import path from 'path';
import os from 'os';
import semver from 'semver';
import {IS_WINDOWS, PLATFORM} from './utils';
import {QualityOptions} from './setup-dotnet';

// -------------------------------
// Multi-arch input support (added)
// -------------------------------
export interface VersionArchEntry {
  version: string;
  architecture: string;
}

// Accepts dotnet-version input and parses into [{version, arch}, ...]
export function parseVersionArchInput(
  dotnetVersionInput: string,
  defaultArch: string
): VersionArchEntry[] {
  const SUPPORTED_ARCHES = ['x64', 'x86', 'arm64'];
  const lines = dotnetVersionInput
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (!lines.length) throw new Error(`dotnet-version input is required`);

  return lines.map(line => {
    // Only new format has "version:"
    if (line.toLowerCase().startsWith('version:')) {
      let version = '';
      let architecture = defaultArch;
      const parts = line.split(',');
      for (let part of parts) {
        const [k, v] = part.split(':').map(s => s.trim());
        if (k.toLowerCase() === 'version') version = v;
        else if (
          k.toLowerCase() === 'arch' ||
          k.toLowerCase() === 'architecture'
        )
          architecture = v;
      }
      if (!version) throw new Error(`Malformed dotnet-version line: ${line}`);
      if (!SUPPORTED_ARCHES.includes(architecture))
        throw new Error(
          `Unsupported architecture: ${architecture}. Supported: ${SUPPORTED_ARCHES.join(', ')}`
        );
      return {version, architecture};
    } else {
      // Legacy style: '6.0.x'
      if (!SUPPORTED_ARCHES.includes(defaultArch))
        throw new Error(
          `Unsupported architecture: ${defaultArch}. Supported: ${SUPPORTED_ARCHES.join(', ')}`
        );
      return {version: line, architecture: defaultArch};
    }
  });
}

// Main multi-arch installation loop
export async function installDotnetVersions(
  entries: VersionArchEntry[],
  quality?: QualityOptions
): Promise<(string | null)[]> {
  const installedVersions: (string | null)[] = [];
  for (const {version, architecture} of entries) {
    core.startGroup(`Installing .NET version ${version} (${architecture})`);
    const installedVersion = await new DotnetCoreInstaller(
      version,
      quality,
      architecture
    ).installDotnet();
    installedVersions.push(installedVersion);
    core.endGroup();
  }
  return installedVersions;
}
// -------------------------------

export interface DotnetVersion {
  type: string;
  value: string;
  qualityFlag: boolean;
}

const QUALITY_INPUT_MINIMAL_MAJOR_TAG = 6;
const LATEST_PATCH_SYNTAX_MINIMAL_MAJOR_TAG = 5;
export class DotnetVersionResolver {
  private inputVersion: string;
  private resolvedArgument: DotnetVersion;

  constructor(version: string) {
    this.inputVersion = version.trim();
    this.resolvedArgument = {type: '', value: '', qualityFlag: false};
  }

  private async resolveVersionInput(): Promise<void> {
    if (!semver.validRange(this.inputVersion) && !this.isLatestPatchSyntax()) {
      throw new Error(
        `The 'dotnet-version' was supplied in invalid format: ${this.inputVersion}! Supported syntax: A.B.C, A.B, A.B.x, A, A.x, A.B.Cxx`
      );
    }
    if (semver.valid(this.inputVersion)) {
      this.createVersionArgument();
    } else {
      await this.createChannelArgument();
    }
  }

  private isNumericTag(versionTag): boolean {
    return /^\d+$/.test(versionTag);
  }

  private isLatestPatchSyntax() {
    const majorTag = this.inputVersion.match(
      /^(?<majorTag>\d+)\.\d+\.\d{1}x{2}$/
    )?.groups?.majorTag;
    if (
      majorTag &&
      parseInt(majorTag) < LATEST_PATCH_SYNTAX_MINIMAL_MAJOR_TAG
    ) {
      throw new Error(
        `The 'dotnet-version' was supplied in invalid format: ${this.inputVersion}! The A.B.Cxx syntax is available since the .NET 5.0 release.`
      );
    }
    return majorTag ? true : false;
  }

  private createVersionArgument() {
    this.resolvedArgument.type = 'version';
    this.resolvedArgument.value = this.inputVersion;
  }

  private async createChannelArgument() {
    this.resolvedArgument.type = 'channel';
    const [major, minor] = this.inputVersion.split('.');
    if (this.isLatestPatchSyntax()) {
      this.resolvedArgument.value = this.inputVersion;
    } else if (this.isNumericTag(major) && this.isNumericTag(minor)) {
      this.resolvedArgument.value = `${major}.${minor}`;
    } else if (this.isNumericTag(major)) {
      this.resolvedArgument.value = await this.getLatestByMajorTag(major);
    } else {
      // If "dotnet-version" is specified as *, x or X resolve latest version of .NET explicitly from LTS channel. The version argument will default to "latest" by install-dotnet script.
      this.resolvedArgument.value = 'LTS';
    }
    this.resolvedArgument.qualityFlag =
      parseInt(major) >= QUALITY_INPUT_MINIMAL_MAJOR_TAG ? true : false;
  }

  public async createDotnetVersion(): Promise<DotnetVersion> {
    await this.resolveVersionInput();
    if (!this.resolvedArgument.type) {
      return this.resolvedArgument;
    }
    if (IS_WINDOWS) {
      this.resolvedArgument.type =
        this.resolvedArgument.type === 'channel' ? '-Channel' : '-Version';
    } else {
      this.resolvedArgument.type =
        this.resolvedArgument.type === 'channel' ? '--channel' : '--version';
    }
    return this.resolvedArgument;
  }

  private async getLatestByMajorTag(majorTag: string): Promise<string> {
    const httpClient = new hc.HttpClient('actions/setup-dotnet', [], {
      allowRetries: true,
      maxRetries: 3
    });

    const response = await httpClient.getJson<any>(
      DotnetVersionResolver.DotnetCoreIndexUrl
    );

    const result = response.result || {};
    const releasesInfo: any[] = result['releases-index'];

    const releaseInfo = releasesInfo.find(info => {
      const sdkParts: string[] = info['channel-version'].split('.');
      return sdkParts[0] === majorTag;
    });

    if (!releaseInfo) {
      throw new Error(
        `Could not find info for version with major tag: "${majorTag}" at ${DotnetVersionResolver.DotnetCoreIndexUrl}`
      );
    }

    return releaseInfo['channel-version'];
  }

  static DotnetCoreIndexUrl =
    'https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json';
}

export class DotnetInstallScript {
  private scriptName = IS_WINDOWS ? 'install-dotnet.ps1' : 'install-dotnet.sh';
  private escapedScript: string;
  private scriptArguments: string[] = [];

  constructor() {
    this.escapedScript = path
      .join(__dirname, '..', '..', 'externals', this.scriptName)
      .replace(/'/g, "''");

    if (IS_WINDOWS) {
      this.setupScriptPowershell();
      return;
    }

    this.setupScriptBash();
  }

  private setupScriptPowershell() {
    this.scriptArguments = [
      '-NoLogo',
      '-Sta',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Unrestricted',
      '-Command'
    ];

    this.scriptArguments.push('&', `'${this.escapedScript}'`);

    if (process.env['https_proxy'] != null) {
      this.scriptArguments.push(`-ProxyAddress ${process.env['https_proxy']}`);
    }
    // This is not currently an option
    if (process.env['no_proxy'] != null) {
      this.scriptArguments.push(`-ProxyBypassList ${process.env['no_proxy']}`);
    }
  }

  private setupScriptBash() {
    chmodSync(this.escapedScript, '777');
  }

  private async getScriptPath() {
    if (IS_WINDOWS) {
      return (await io.which('pwsh', false)) || io.which('powershell', true);
    }

    return io.which(this.escapedScript, true);
  }

  public useArguments(...args: string[]) {
    this.scriptArguments.push(...args);
    return this;
  }

  public useVersion(dotnetVersion: DotnetVersion, quality?: QualityOptions) {
    if (dotnetVersion.type) {
      this.useArguments(dotnetVersion.type, dotnetVersion.value);
    }

    if (quality && !dotnetVersion.qualityFlag) {
      core.warning(
        `The 'dotnet-quality' input can be used only with .NET SDK version in A.B, A.B.x, A, A.x and A.B.Cxx formats where the major tag is higher than 5. You specified: ${dotnetVersion.value}. 'dotnet-quality' input is ignored.`
      );
      return this;
    }

    if (quality) {
      this.useArguments(IS_WINDOWS ? '-Quality' : '--quality', quality);
    }

    return this;
  }

  // --- ADDED: pass in architecture argument ---
  public useArchitecture(arch: string) {
    if (arch && arch !== '') {
      this.useArguments(IS_WINDOWS ? '-Architecture' : '--architecture', arch);
    }
    return this;
  }
  // ---

  public async execute() {
    const getExecOutputOptions = {
      ignoreReturnCode: true,
      env: process.env as {string: string}
    };

    return exec.getExecOutput(
      `"${await this.getScriptPath()}"`,
      this.scriptArguments,
      getExecOutputOptions
    );
  }
}

export abstract class DotnetInstallDir {
  private static readonly default = {
    linux: '/usr/share/dotnet',
    mac: path.join(process.env['HOME'] + '', '.dotnet'),
    windows: path.join(process.env['PROGRAMFILES'] + '', 'dotnet')
  };

  public static readonly dirPath = process.env['DOTNET_INSTALL_DIR']
    ? DotnetInstallDir.convertInstallPathToAbsolute(
        process.env['DOTNET_INSTALL_DIR']
      )
    : DotnetInstallDir.default[PLATFORM];

  private static convertInstallPathToAbsolute(installDir: string): string {
    if (path.isAbsolute(installDir)) return path.normalize(installDir);

    const transformedPath = installDir.startsWith('~')
      ? path.join(os.homedir(), installDir.slice(1))
      : path.join(process.cwd(), installDir);

    return path.normalize(transformedPath);
  }

  public static addToPath() {
    core.addPath(process.env['DOTNET_INSTALL_DIR']!);
    core.exportVariable('DOTNET_ROOT', process.env['DOTNET_INSTALL_DIR']);
  }

  public static setEnvironmentVariable() {
    process.env['DOTNET_INSTALL_DIR'] = DotnetInstallDir.dirPath;
  }
}

export class DotnetCoreInstaller {
  static {
    DotnetInstallDir.setEnvironmentVariable();
  }

  constructor(
    private version: string,
    private quality: QualityOptions | undefined,
    private architecture: string // Added - pass arch to installer
  ) {}

  public async installDotnet(): Promise<string | null> {
    const versionResolver = new DotnetVersionResolver(this.version);
    const dotnetVersion = await versionResolver.createDotnetVersion();

    // Install dotnet runtime first for CLI
    const runtimeInstallOutput = await new DotnetInstallScript()
      .useArguments(
        IS_WINDOWS ? '-SkipNonVersionedFiles' : '--skip-non-versioned-files'
      )
      .useArguments(IS_WINDOWS ? '-Runtime' : '--runtime', 'dotnet')
      .useArguments(IS_WINDOWS ? '-Channel' : '--channel', 'LTS')
      .useArchitecture(this.architecture) // Pass arch
      .execute();

    if (runtimeInstallOutput.exitCode) {
      /**
       * dotnetInstallScript will install CLI and runtime even if previous script haven't succeded,
       * so at this point it's too early to throw an error
       */
      core.warning(
        `Failed to install dotnet runtime + cli, exit code: ${runtimeInstallOutput.exitCode}. ${runtimeInstallOutput.stderr}`
      );
    }

    // Install SDK for target version/arch
    const dotnetInstallOutput = await new DotnetInstallScript()
      .useArguments(
        IS_WINDOWS ? '-SkipNonVersionedFiles' : '--skip-non-versioned-files'
      )
      .useVersion(dotnetVersion, this.quality)
      .useArchitecture(this.architecture) // Pass arch
      .execute();

    if (dotnetInstallOutput.exitCode) {
      throw new Error(
        `Failed to install dotnet, exit code: ${dotnetInstallOutput.exitCode}. ${dotnetInstallOutput.stderr}`
      );
    }

    return this.parseInstalledVersion(dotnetInstallOutput.stdout);
  }

  private parseInstalledVersion(stdout: string): string | null {
    const regex = /(?<version>\d+\.\d+\.\d+[a-z0-9._-]*)/gm;
    const matchedResult = regex.exec(stdout);

    if (!matchedResult) {
      core.warning(`Failed to parse installed by the script version of .NET`);
      return null;
    }
    return matchedResult.groups!.version;
  }
}
