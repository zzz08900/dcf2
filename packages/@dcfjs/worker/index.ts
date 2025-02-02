import { TempStorage } from './../common/tempStorage';
import { ServerConfig } from './../common/server';

import {
  createServer,
  ServerHandlerMap,
  ServerBadRequestError,
} from '@dcfjs/common/server';
import { createClient } from '../common/client';
import { Http2Session } from 'http2';
import { deserializeFunction } from '../common/serializeFunction';
import '@dcfjs/common/registerCaptureEnv';
import { fork } from 'child_process';

import debugFactory from 'debug';
import {
  registerTempStorage,
  removeAllStorages,
  getStorageEntries,
} from '@dcfjs/common/storageRegistry';

const debug = debugFactory('worker:cli');

export async function registerWorker(
  masterEndpoint: string,
  endpoint: string,
  workerSecret: string,
) {
  const client = await createClient(masterEndpoint);
  try {
    await client.post('/worker/register', {
      endpoint,
      secret: workerSecret,
    });
  } finally {
    await client.close();
  }
}

export async function createWorkerServer(
  masterEndpoint: string,
  workerSecret: string,
  option?: ServerConfig,
) {
  let workerId: string | null = null;
  let masterSession: Http2Session | null = null;
  let endpoint: string | null = null;

  const ServerHandlers: ServerHandlerMap = {
    '/init': ({ secret, id }, sess) => {
      if (secret !== workerSecret) {
        throw new ServerBadRequestError('Bad Secret');
      }
      workerId = id;
      masterSession = sess;

      // Exit and restart if this session was closed.
      sess.on('close', () => {
        debug('Shutting down because of master session was closed.');
        process.emit('SIGINT', 'SIGINT');
      });
    },
    '/init-storage': async ({ name, factory }) => {
      factory = deserializeFunction(factory);
      const storage: TempStorage = factory({
        workerId,
        endpoint,
      });
      if (storage.cleanUp) {
        await storage.cleanUp();
      }
      registerTempStorage(name, storage);
    },
    '/exec': (func, sess) => {
      if (sess !== masterSession) {
        throw new ServerBadRequestError('Only master can execute scripts.');
      }
      const f = deserializeFunction(func);
      return f(workerId);
    },
  };

  const timer = setInterval(() => {
    for (const [key, storage] of getStorageEntries()) {
      if (storage.cleanUp) {
        storage.cleanUp();
      }
    }
  }, 60000);

  const server = await createServer(ServerHandlers, option);
  endpoint = server.endpoint;

  server.on('close', () => {
    clearInterval(timer);
    removeAllStorages();
  });

  // Register worker.
  await registerWorker(masterEndpoint, server.endpoint, workerSecret);

  debug(`Worker ${workerId} registered.`);

  return server;
}

export async function createLocalWorker(masterEndpoint: string) {
  const cp = fork(require.resolve('./cli.js'), [], {
    env: {
      ...process.env,
      // Do not pass master port to worker.
      PORT: '',
      HOST: '',
      MASTER_ENDPOINT: masterEndpoint,
    },
    stdio: 'inherit',
  });

  await new Promise((resolve, reject) => {
    cp.on('message', resolve);
    cp.on('exit', (code, signal) => {
      debug('Worker process exited: ', code, signal);
      reject(new Error('Child process exited.'));
    });
  });

  return (): Promise<void> => {
    debug('Killing child process');
    cp.kill('SIGTERM');
    return new Promise(resolve => {
      cp.on('exit', (code, signal) => {
        resolve();
      });
    });
  };
}
