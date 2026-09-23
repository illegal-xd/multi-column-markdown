/**
 * Bundled worker entry point (`dist/dataviewWorker.js`).
 *
 * Deliberately tiny: it exists so the worker script has a stable file to
 * `new Worker(...)` against (VSCode extension hosts cannot load worker code
 * from a string, and the extension bundle itself must not be reused because a
 * worker thread would then re-run `activate()`).
 *
 * Kept separate from `workerRuntime.ts` so unit tests can import
 * `createRunJob` without spawning a real worker thread at import time.
 */
import {bootstrap} from "./workerRuntime";

bootstrap();
