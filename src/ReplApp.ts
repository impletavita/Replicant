import * as repl from 'repl';
import * as fs from 'fs';
import * as vm from 'vm';
import glob from 'glob';
import Path from 'path';
import {pathToFileURL} from 'url';
import {CommandLineArgsParser, ReplAppArgs} from './CommandLineArgsParser';
import {ParseArgsConfig} from 'util';
import {assert} from './ReplAssert';

interface LooseObject {
  [key: string]: unknown;
}

export class ReplApp {
  static replAppArgs: ReplAppArgs;

  static imports = new Map();

  static async start(
    initFilePaths: string[] = [],
    argsConfig?: ParseArgsConfig,
    optionsDescription?: {[option: string]: string}
  ): Promise<repl.REPLServer[]> {
    const replAppArgs = CommandLineArgsParser.getArgs(argsConfig);

    if (replAppArgs.initFilePaths) {
      initFilePaths.push(...replAppArgs.initFilePaths);
    }

    let repls: repl.REPLServer[] = [];

    // TODO: This belongs in the actual repls, not in repl-app
    if (replAppArgs.parsedArgs.values['help'] as string) {
      ReplApp.showHelpText(optionsDescription);
      return repls;
    }
    let initFileContents: LooseObject = {};

    const contents = await Promise.all(
      initFilePaths.map(async p => await ReplApp.getInitFileContents(p))
    );

    initFileContents = Object.assign(
      {CommandLineArgs: replAppArgs},
      ...contents
    );

    const replContext = ReplApp.getContext();

    if (replAppArgs.scriptPaths.length === 0) {
      repls = ReplApp.startRepl(replContext, initFileContents);
    } else {
      repls = ReplApp.startBatchRepl(
        replContext,
        initFileContents,
        replAppArgs.scriptPaths
      );
    }

    return repls;
  }

  static showHelpText(
    optionDescriptions: {[option: string]: string} | undefined
  ) {
    if (optionDescriptions) {
      Object.entries(optionDescriptions).forEach(([option, description]) => {
        console.log(`  --${option}\t${description}`);
      });
    }
  }

  static async linker(specifier: string, referencingModule: vm.Module) {
    if (specifier === 'foo') {
      return new vm.SourceTextModule('', {context: referencingModule.context});
    }

    throw new Error(`Unable to resolve dependency: ${specifier}`);
  }
  static startBatchRepl(
    replContext: repl.ReplOptions,
    initFileContents: LooseObject,
    args: string[]
  ) {
    const files = ReplApp.getFiles(args);
    const repls: repl.REPLServer[] = [];

    const contextifiedObject = vm.createContext({console, ...initFileContents});

    const linker = async (specifier: string, referencingModule: vm.Module) => {
      if (specifier === 'foo') {
        return new vm.SourceTextModule('', {
          context: referencingModule.context,
        });
      }

      throw new Error(`Unable to resolve dependency: ${specifier}`);
    }
    files.forEach(async (f: string) => {
      const fileContents = fs.readFileSync(f, 'utf-8');

      // Important: do not modify fileContents before passing to 
      // SourceTextModule, as that will affect identifying the correct lines
      // in test run reports.
      const bar = new vm.SourceTextModule(fileContents, {
        context: contextifiedObject,
      });
      await bar.link(linker);
      await bar.evaluate();
    });

    return repls;
  }

  static startRepl(
    replContext: repl.ReplOptions,
    initFileContents: LooseObject
  ) {
    const replServer = repl.start(replContext);

    Object.keys(initFileContents).forEach(k => {
      replServer.context[k] = initFileContents[k];
    });

    return [replServer];
  }

  static async getInitFileContents(initFileName: string): Promise<LooseObject> {
    // converts a path to its file URL equivalent, after first
    // converting to absolute if needed
    const getAbsolutePathFileURL = (p: string) => {
      if (Path.isAbsolute(p)) {
        return pathToFileURL(p).href;
      }

      const __dirname = pathToFileURL(process.cwd()).href;
      return Path.join(__dirname, p);
    };

    initFileName = getAbsolutePathFileURL(initFileName);

    let initFileContents = {};

    try {
      initFileContents = await import(initFileName);
    } catch (err) {
      console.log(`Error importing init file: ${initFileName}: ${err}`);
    }

    return initFileContents;
  }

  static getContext(): repl.ReplOptions {
    const replContext = {ignoreUndefined: true};
    return replContext;
  }

  static getJSONFileContentsAsObject(jsonFileName: string) {
    // TODO: For now, cannot use dynamic imports with JSON files without the experimental switch,
    // TODO: so simply read the file and deserialize. Can later merge with the getInitFileContents
    // TODO: code above once the switch is no longer needed
    const path = ReplApp.getAbsolutePath(jsonFileName);
    return JSON.parse(fs.readFileSync(path, 'utf-8'));
  }

  static getAbsolutePath(p: string) {
    if (Path.isAbsolute(p)) {
      return p;
    }

    const __dirname = process.cwd();
    return Path.join(__dirname, p);
  }

  /**
   * Returns a flat array of all descendant files of the specified paths.
   * TODO: Look for specific extensions like '.js' and '.ts' only.
   * @param paths one or more file or folder paths
   * @returns a flat array of all files found
   */
  static getFiles(paths: string[]) {
    const __dirname = process.cwd();

    const files = paths.map(a => {
      const absoluteFilePath = Path.join(__dirname, a);
      if (fs.existsSync(absoluteFilePath)) {
        const stats = fs.lstatSync(absoluteFilePath);
        if (stats.isFile()) {
          return absoluteFilePath;
        }

        if (stats.isDirectory()) {
          let globPattern = Path.resolve(
            Path.join(absoluteFilePath, '/**/*.js')
          );

          if (Path.sep !== '/') {
            globPattern = globPattern.replace(/\\/g, '/');
          }

          return glob.sync(globPattern);
        }
      }

      // TODO: How do we inform the user when the file does not exist?
      console.log(`did not find file or folder ${absoluteFilePath}`);
      return null;
    }) as string[];

    return files.flat();
  }
}

export {ReplAppArgs, CommandLineArgsParser, assert};
