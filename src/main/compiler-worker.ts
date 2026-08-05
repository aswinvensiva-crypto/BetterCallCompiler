import { parentPort } from 'node:worker_threads'
import { isWorkerRequest, type WorkerMessage, type WorkerRequest } from '../shared/compiler-protocol'

/**
 * The compiler daemon, running in a worker_thread.
 *
 * Never imports electron. It is a plain Node worker spawned by the main
 * process, which is what keeps a full TypeScript check off the thread that
 * draws the window — `getSemanticDiagnostics` is synchronous and would freeze
 * the UI for as long as it runs.
 *
 * This step is deliberately the skeleton only: boot, heartbeat, and a clean
 * exit. The graph and the LanguageService land in the following steps, once the
 * build and spawn plumbing has been proven to work in dev, under test, and
 * inside an asar archive.
 */

const port = parentPort

function post(message: WorkerMessage): void {
  port?.postMessage(message)
}

/**
 * Epoch ms at which the current synchronous check began, or null when idle.
 *
 * Reported on every pong so the supervisor can tell a busy worker from a wedged
 * one. Without it, a long check looks identical to a hang and gets killed.
 */
let busySince: number | null = null

function heapUsedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10
}

function handle(request: WorkerRequest): void {
  switch (request.type) {
    case 'ping':
      post({ type: 'pong', nonce: request.nonce, heapUsedMb: heapUsedMb(), busySince })
      return

    case 'boot':
      post({
        type: 'state',
        state: 'idle',
        graph: {
          fileCount: 0,
          edgeCount: 0,
          cycles: [],
          truncated: false,
          lastBuildMs: 0,
          tsconfigRelativePath: null
        },
        checkedFileCount: 0
      })
      return

    // Accepted and ignored until the graph lands in the next step. Ignoring
    // them silently is correct for now; failing would make the supervisor
    // restart a worker that is behaving exactly as intended.
    case 'filesChanged':
    case 'openDocument':
    case 'closeDocument':
      return

    case 'dependents':
      post({
        type: 'dependentsResult',
        requestId: request.requestId,
        query: { node: null, dependents: [], cycle: null }
      })
      return
  }
}

if (port !== null) {
  port.on('message', (raw: unknown) => {
    if (!isWorkerRequest(raw)) return
    try {
      handle(raw)
    } catch (error) {
      // A throw here would kill the thread and trip the supervisor's restart
      // budget. Reporting it keeps the daemon alive and the reason visible.
      post({
        type: 'failure',
        detail: error instanceof Error ? error.message : 'unknown worker error'
      })
    }
  })

  post({ type: 'ready' })
}
