import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import os from 'os';
import path from 'path';

const DOTNET_BUILD_FEED = 'https://builds.dotnet.microsoft.com/dotnet';

export class ExperimentalWindowsDotnetInstaller {
  public constructor(
    private readonly version: string,
    private readonly architecture: string,
    private readonly installDirectory: string
  ) {}

  public async installSdk(): Promise<string> {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(this.version)) {
      throw new Error(
        `Experimental Node Windows installer supports exact SDK versions only. Received '${this.version}'.`
      );
    }

    const normalizedArchitecture =
      this.architecture.toLowerCase() === 'amd64'
        ? 'x64'
        : this.architecture.toLowerCase();

    const archiveUrl =
      `${DOTNET_BUILD_FEED}/Sdk/${this.version}/` +
      `dotnet-sdk-${this.version}-win-${normalizedArchitecture}.zip`;

    const archivePath = path.join(
      process.env['RUNNER_TEMP'] || os.tmpdir(),
      `dotnet-sdk-${this.version}-win-${normalizedArchitecture}.zip`
    );

    core.info(`Experimental Node installer downloading: ${archiveUrl}`);

    const downloadStart = performance.now();
    const downloadedArchivePath = await tc.downloadTool(
      archiveUrl,
      archivePath
    );
    const downloadSeconds = (performance.now() - downloadStart) / 1000;

    core.info(
      `Experimental Node installer download completed in ${downloadSeconds.toFixed(3)} seconds.`
    );

    core.info(
      `Experimental Node installer extracting ZIP directly to: ${this.installDirectory}`
    );

    const extractionStart = performance.now();

    // Intentional experiment behavior:
    // extractZip performs a bulk extraction into the actual installation root.
    // It does not reproduce SkipNonVersionedFiles or side-by-side merge rules.
    await tc.extractZip(downloadedArchivePath, this.installDirectory);

    const extractionSeconds = (performance.now() - extractionStart) / 1000;

    core.info(
      `Experimental Node installer extraction completed in ${extractionSeconds.toFixed(3)} seconds.`
    );

    return this.version;
  }
}
