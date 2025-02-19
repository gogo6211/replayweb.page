/* eslint-env node */

import fetch from "node-fetch";
import { Headers } from "node-fetch";

import {
  app,
  session,
  BrowserWindow,
  ipcMain,
  protocol,
  screen,
  shell,
} from "electron";

import path from "path";
import fs from "fs";

import { ArchiveResponse, Rewriter } from "@webrecorder/wabac";

import { PassThrough, Readable } from "stream";

import { autoUpdater } from "electron-updater";
import log from "electron-log";

// @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7016 - Could not find a declaration file for module 'mime-types'. 'node_modules/mime-types/index.js' implicitly has an 'any' type.
import mime from "mime-types";
import url from "url";

// @ts-expect-error - TS2322 - Type 'typeof Headers' is not assignable to type '{ new (init?: HeadersInit | undefined): Headers; prototype: Headers; }'.
global.Headers = Headers;
// @ts-expect-error - TS2322 - Type '(url: RequestInfo, init?: RequestInit | undefined) => Promise<Response>' is not assignable to type '(input: RequestInfo, init?: RequestInit | undefined) => Promise<Response>'.
global.fetch = fetch;

const STATIC_PREFIX = "http://localhost:5471/";

const REPLAY_PREFIX = STATIC_PREFIX + "w/";

const FILE_PROTO = "file2";

const URL_RX = /([^/]+)\/([\d]+)(?:\w\w_)?\/(.*)$/;

// ============================================================================
class ElectronReplayApp {
  pluginPath = "";

  appPath = app.getAppPath();

  projPath = path.join(this.appPath, "../");

  staticContentPath = "./";

  profileName = "";

  proxyColl: string | null = null;

  proxyTS: string | null = null;

  mainWindow: BrowserWindow | null = null;

  openNextFile: string | null = null;

  screenSize = { width: 1024, height: 768 };

  origUA: string | null = null;

  constructor({ staticPath = "./", profileName = "" } = {}) {
    this.staticContentPath = staticPath;
    this.profileName = profileName;
  }

  get mainWindowWebPreferences() {
    return {
      plugins: true,
      preload: path.join(__dirname, "preload.js"),
      nativeWindowOpen: true,
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: false,
      nodeIntegration: false,
    };
  }

  get mainWindowUrl() {
    return "index.html";
  }

  init() {
    // Single instance check
    const gotTheLock = app.requestSingleInstanceLock();

    if (!gotTheLock) {
      console.log(
        "App already running, opening new window in first instance and quitting",
      );
      app.quit();
    } else {
      app.on("second-instance", (event, commandLine /*, workingDir*/) => {
        // Just create a new window in case of second instance request
        this.createMainWindow(commandLine);
      });
    }

    console.log("app path", this.appPath);
    console.log("dir name", __dirname);
    console.log("proj path", this.projPath);

    console.log("app data", app.getPath("appData"));
    console.log("user data", app.getPath("userData"));

    if (this.profileName) {
      app.setPath(
        "userData",
        path.join(app.getPath("appData"), this.profileName),
      );
    }

    protocol.registerSchemesAsPrivileged([
      {
        scheme: FILE_PROTO,
        privileges: {
          standard: false,
          secure: true,
          bypassCSP: true,
          allowServiceWorkers: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
    ]);

    app.on("will-finish-launching", () => {
      app.on("open-file", (event, filePath) => {
        this.openNextFile = filePath;
        if (this.mainWindow) {
          this.createMainWindow(process.argv);
        }
      });
    });

    app.on("activate", () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) {
        this.mainWindow = this.createMainWindow(process.argv);
      }
    });

    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    app.whenReady().then(() => this.onAppReady());

    // Quit when all windows are closed.
    app.on("window-all-closed", function () {
      // On macOS it is common for applications and their menu bar
      // to stay active until the user quits explicitly with Cmd + Q
      //if (process.platform !== 'darwin')
      app.quit();
    });
  }

  checkUpdates() {
    autoUpdater.logger = log;
    // @ts-expect-error - TS2339 - Property 'transports' does not exist on type 'Logger'.
    autoUpdater.logger.transports.file.level = "info";
    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    autoUpdater.checkForUpdatesAndNotify();
  }

  onAppReady() {
    this.checkUpdates();

    this.screenSize = screen.getPrimaryDisplay().workAreaSize;

    app.on("web-contents-created", (event, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        // load docs in native browser for now
        if (url === STATIC_PREFIX + "docs") {
          // TODO: Fix this the next time the file is edited.
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          shell.openExternal("https://replayweb.page/docs/");
          return { action: "deny" };
        }

        // load external URLs in native browser
        if (!url.startsWith(STATIC_PREFIX)) {
          // TODO: Fix this the next time the file is edited.
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          shell.openExternal(url);
          return { action: "deny" };
        }

        return { action: "allow" };
      });
    });

    const sesh = session.defaultSession;

    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    sesh.protocol.interceptStreamProtocol("http", (request, callback) =>
      this.doIntercept(request, callback),
    );

    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    protocol.registerStreamProtocol(FILE_PROTO, (request, callback) =>
      this.doHandleFile(request, callback),
    );

    this.origUA = sesh.getUserAgent();

    this.mainWindow = this.createMainWindow(process.argv);
  }

  // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'request' implicitly has an 'any' type. | TS7006 - Parameter 'callback' implicitly has an 'any' type.
  async doHandleFile(request, callback) {
    //const parsedUrl = new URL(request.url);
    //const filename = parsedUrl.searchParams.get("filename");

    if (request.url === FILE_PROTO + "://localhost") {
      callback({ statusCode: 200, data: null });
      return;
    }

    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const filename = url.fileURLToPath(request.url.replace(FILE_PROTO, "file"));

    const headers = { "Content-Type": "application/octet-stream" };
    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const reqHeaders = new Headers(request.headers);

    if (filename) {
      const stat = await fs.promises.lstat(filename);

      if (!stat.isFile()) {
        return this.notFound(filename, callback);
      }

      const size = stat.size;

      const { statusCode, start, end } = this.parseRange(
        reqHeaders,
        headers,
        size,
      );

      const data =
        request.method === "HEAD"
          ? null
          : fs.createReadStream(filename, { start, end });

      callback({ statusCode, headers, data });
      return;
    } else {
      return this.notFound("No Resource Specified", callback);
    }
  }

  // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'data' implicitly has an 'any' type.
  _bufferToStream(data) {
    const rv = new PassThrough();
    rv.push(data);
    rv.push(null);
    return rv;
  }

  async doIntercept(
    // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'request' implicitly has an 'any' type.
    request,
    callback: (response: {
      statusCode: number;
      headers: Record<string, string>;
      data: fs.ReadStream;
    }) => void,
  ) {
    console.log(`${request.method} ${request.url} from ${request.referrer}`);

    // if local server
    if (request.url.startsWith(STATIC_PREFIX)) {
      //if replay prefix
      if (request.url.startsWith(REPLAY_PREFIX)) {
        const m = request.url.slice(REPLAY_PREFIX.length).match(URL_RX);
        if (m) {
          this.proxyColl = m[1];
          this.proxyTS = m[2];

          request.url = m[3];
          return await this.resolveArchiveResponse(request, callback);
        }
      } else {
        // try serve static file from app dir
        let filename = request.url.slice(STATIC_PREFIX.length).split("?", 1)[0];
        filename = filename.split("#", 1)[0];

        if (filename === "") {
          filename = "index.html";
        } else if (filename === "docs") {
          filename = "docs/index.html";
        }

        // TODO: Fix this the next time the file is edited.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        let ext = path.extname(filename);
        if (!ext) {
          ext = ".html";
          filename += ext;
        }

        const mimeType = mime.contentType(ext);

        if (mimeType) {
          // TODO: Fix this the next time the file is edited.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          const fullPath = path.join(this.staticContentPath, filename);

          console.log("fullPath: " + fullPath);

          const data = fs.createReadStream(fullPath);

          return callback({
            statusCode: 200,
            headers: { "content-type": mimeType },
            data,
          });
        }
      }

      return this.notFound(request.url, callback);
    }

    // possible 'live leak' attempt, return archived version, if any
    if (request.referrer?.startsWith(REPLAY_PREFIX)) {
      return await this.resolveArchiveResponse(request, callback);
    }

    await this.proxyLive(request, callback);
  }

  // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'request' implicitly has an 'any' type. | TS7006 - Parameter 'callback' implicitly has an 'any' type.
  async proxyLive(request, callback) {
    let headers = request.headers;
    const { method, url, uploadData } = request;

    const body = uploadData
      ? Readable.from(readBody(uploadData, session.defaultSession))
      : null;

    if (this.origUA) {
      // pass UA if origUA is set
      headers["User-Agent"] = this.origUA;
    }

    let response;

    try {
      // TODO: Fix this the next time the file is edited.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      response = await fetch(url, { method, headers, body });
    } catch (e) {
      console.warn("fetch failed for: " + url);
      callback({ statusCode: 502, headers: {}, data: null });
      return;
    }
    const data = method === "HEAD" ? null : response.body;
    const statusCode = response.status;

    headers = Object.fromEntries(response.headers.entries());
    callback({ statusCode, headers, data });
  }

  /**
   *
   * @param {string} url
   * @param {(props: {
   *    statusCode: number;
   *    headers: Record<string, string>;
   *    data: unknown;
   * }) => void} callback
   */
  // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'url' implicitly has an 'any' type. | TS7006 - Parameter 'callback' implicitly has an 'any' type.
  notFound(url, callback) {
    console.log("not found: " + url);
    const data = this._bufferToStream(
      `Sorry, the url <b>${url}</b> could not be found in this archive.`,
    );
    callback({
      statusCode: 404,
      headers: { "Content-Type": 'text/html; charset="utf-8"' },
      data,
    });
  }

  // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'request' implicitly has an 'any' type. | TS7006 - Parameter 'callback' implicitly has an 'any' type.
  async resolveArchiveResponse(request, callback) {
    const channel = `req:${new Date().getTime()}:${request.url}`;

    ipcMain.once(channel, async (event, status, headers, payload) => {
      const url = request.url;

      if (status === 404 && !payload) {
        return this.notFound(url, callback);
      } else {
        console.log("got response for: " + url);
      }

      // TODO: Fix this the next time the file is edited.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      headers = new Headers(headers);
      const date = new Date();

      let response: ArchiveResponse = new ArchiveResponse({
        payload,
        headers,
        status,
        date,
        url,
      });

      const rewriter = new Rewriter({
        baseUrl: url,
        prefix: "",
        urlRewrite: false,
        contentRewrite: true,
        decode: true,
        useBaseRules: true,
      });

      // TODO: Fix this the next time the file is edited.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      request.headers = new Headers(request.headers);

      try {
        response = await rewriter.rewrite(response, request);

        // TODO: Fix this the next time the file is edited.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        headers = Object.fromEntries(response.headers.entries());

        let data = await response.getBuffer();
        if (!data) {
          data = new Uint8Array();
        }

        if (status === 206 || status === 200) {
          const { statusCode, start, end } = this.parseRange(
            request.headers,
            headers,
            data.length,
          );
          if (start !== undefined) {
            data = data.slice(start, end);
          }
          status = statusCode;
        }

        const result = this._bufferToStream(data);

        callback({ statusCode: status, headers, data: result });
      } catch (e) {
        console.warn(e);
      }
    });

    if (this.mainWindow) {
      this.mainWindow.webContents.send(
        "getresponse",
        request,
        this.proxyColl,
        this.proxyTS,
        channel,
      );
    }
  }

  // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'reqHeaders' implicitly has an 'any' type. | TS7006 - Parameter 'headers' implicitly has an 'any' type. | TS7006 - Parameter 'size' implicitly has an 'any' type.
  parseRange(reqHeaders, headers, size) {
    let statusCode = 200;
    const range = reqHeaders.get("range");

    if (!range) {
      if (headers) {
        headers["Content-Length"] = "" + size;
      }
      return { statusCode };
    }

    const m = range.match(/bytes=([\d]+)-([\d]*)/);
    if (!m) {
      return { statusCode };
    }

    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : size - 1;
    statusCode = 206;
    if (headers) {
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      headers["Content-Length"] = `${end - start + 1}`;
    }
    return { statusCode, start, end };
  }

  // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'argv' implicitly has an 'any' type.
  createMainWindow(argv) {
    const sourceString = this.getOpenUrl(argv);

    // Create the browser window.
    const theWindow = new BrowserWindow({
      width: this.screenSize.width,
      height: this.screenSize.height,
      // @ts-expect-error - TS2345 - Argument of type '{ width: any; height: any; isMaximized: boolean; show: false; webPreferences: { plugins: boolean; preload: string; nativeWindowOpen: boolean; contextIsolation: boolean; enableRemoteModule: boolean; sandbox: boolean; nodeIntegration: boolean; }; }' is not assignable to parameter of type 'BrowserWindowConstructorOptions'.
      isMaximized: true,
      show: false,
      webPreferences: this.mainWindowWebPreferences,
    }).once("ready-to-show", () => {
      theWindow.show();
      theWindow.maximize();
    });

    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    theWindow.loadURL(STATIC_PREFIX + this.mainWindowUrl + sourceString);
    if (process.env.NODE_ENV === "development") {
      theWindow.webContents.openDevTools();
    }

    return theWindow;
  }

  // @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'argv' implicitly has an 'any' type.
  getOpenUrl(argv) {
    argv = require("minimist")(argv.slice(process.defaultApp ? 2 : 1));

    const filename =
      this.openNextFile ||
      argv.filename ||
      argv.f ||
      (argv._.length && argv._[0]);
    this.openNextFile = null;

    let sourceString = "";

    if (filename) {
      const sourceParams = new URLSearchParams();
      sourceParams.set("source", "file://" + filename);
      sourceString = "?" + sourceParams.toString();

      const urlParams = new URLSearchParams();

      const openUrl = argv.url;

      const openTS = argv.ts || argv.timestamp;

      if (openUrl) {
        // TODO: Fix this the next time the file is edited.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        urlParams.set("url", openUrl);
      }

      if (openTS) {
        // TODO: Fix this the next time the file is edited.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        urlParams.set("ts", openTS);
      }

      sourceString += "#" + urlParams.toString();

      console.log(`Opening Source: ${sourceString}`);
    }

    return sourceString;
  }
}

// @ts-expect-error [// TODO: Fix this the next time the file is edited.] - TS7006 - Parameter 'body' implicitly has an 'any' type. | TS7006 - Parameter 'session' implicitly has an 'any' type.
async function* readBody(body, session) {
  for (const chunk of body) {
    if (chunk.bytes) {
      yield await Promise.resolve(chunk.bytes);
    } else if (chunk.blobUUID) {
      yield await session.getBlobData(chunk.blobUUID);
    }
  }
}

export { ElectronReplayApp, STATIC_PREFIX };
