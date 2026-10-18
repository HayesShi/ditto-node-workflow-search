// Adapted from MFlow@437040f17a17cbf430f3f41227ca64c576cf1056/src/python-tool.ts.
// MIT license: third-party-licenses/MFlow.txt. Isolation and execution limits are unchanged.
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Sandbox, createLocalSandboxExecutor } from '@codesoul-co/ditto/runtime/sandbox';
import type { RegisteredTool } from '@codesoul-co/ditto/worker/interaction';

export const BASELINE_PYTHON_IMAGE = 'sha256:2fc2c915ed384368f492e415d42f7491defbaaa29436b3013e84627fe85b57a6';
export const PYTHON_DESCRIPTION = 'Execute Python 3 code in a fresh isolated container. Print the result. Standard library math, fractions, decimal, itertools and statistics are available. No network, host files or persistent state. Execution timeout 30 seconds.';
export const PYTHON_SCHEMA = Object.freeze({ type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false });
export const PYTHON_ACTION = Object.freeze({ name: 'python', description: PYTHON_DESCRIPTION, inputSchema: PYTHON_SCHEMA });
const dockerCommand = () => process.env.DITTO_DOCKER ?? 'docker';
const health = new AsyncLocalStorage<{ failure?: Error }>();
export function withMathPythonScope<T>(run: () => T): T { return health.run({}, run); }
export function assertMathPythonHealthy(): void { const failure = health.getStore()?.failure; if (failure) throw failure; }
function infrastructure(message: string, cause?: unknown): Error {
  const error = new Error(`TOOL_INFRASTRUCTURE: ${message}`, { cause });
  const scope = health.getStore(); if (scope) scope.failure = error;
  return error;
}

export function pythonExecutor() {
  const env: Record<string, string> = {};
  // The public executor does not inherit the parent environment. These are
  // Docker client settings only; none are forwarded into the Python container.
  for (const key of ['PATH', 'SystemRoot', 'USERPROFILE', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return createLocalSandboxExecutor({ commands: [dockerCommand()], env, timeoutMs: 40_000, maxOutputBytes: 1_048_576 });
}

/** Resolve immutable image identity before any model call; never pull or use host Python. */
export async function mathPythonIdentity() {
  const sandbox = new Sandbox(process.cwd(), { execute: true }, pythonExecutor());
  const requested = process.env.DITTO_MATH_PYTHON_IMAGE ?? BASELINE_PYTHON_IMAGE;
  let result;
  try { result = await sandbox.run({ command: dockerCommand(), args: ['image', 'inspect', requested, '--format', '{{.Id}}'] }); }
  catch (error) { throw new Error('MATH Python requires Docker and the preloaded baseline image; no host-Python fallback', { cause: error }); }
  const image = result.stdout.trim();
  if (result.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('MATH Python requires a running Docker daemon and a preloaded image');
  if (image !== BASELINE_PYTHON_IMAGE) throw new Error(`MATH Python image differs from the pinned MFlow baseline: ${image}`);
  return Object.freeze({ version: 'mflow-python-tool-v1', image, executionSeconds: 30, commandSeconds: 40,
    outputBytes: 1_048_576, memory: '256m', cpus: 1, pids: 64, network: 'none', persistentState: false });
}
export type MathPythonIdentity = Awaited<ReturnType<typeof mathPythonIdentity>>;

export function createPythonTool(image: string): RegisteredTool {
  if (image !== BASELINE_PYTHON_IMAGE) throw new Error('Python tool must use the pinned baseline image');
  return {
    ...PYTHON_ACTION, effects: ['execute'], validate() {},
    async execute(args, context) {
      if (Object.keys(args).length !== 1 || typeof args.code !== 'string' || args.code.length === 0) return {
        status: 'failed', content: 'Python requires exactly one field: code, a non-empty string containing Python source. Supply corrected arguments.',
        error: { code: 'PYTHON_ARGUMENTS', message: 'Invalid Python arguments' },
      };
      const container = `ditto-tool-${randomUUID()}`, started = `MFLOW_STARTED_${randomUUID()}\n`;
      const result = await context.services.sandbox.run({ command: dockerCommand(), args: [
        'run', '--rm', '--init', '--name', container, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m',
        '--cpus', '1', '--user', '65534:65534', '--tmpfs', '/tmp:rw,nosuid,size=16m',
        image, 'sh', '-c', 'printf "%s" "$1"; exec timeout -s KILL 30 python -B -I -c "$2"', 'tool', started, args.code,
      ] }, context.signal).catch(error => {
        if (context.signal?.aborted) throw error;
        if (error instanceof Error && error.name === 'TimeoutError') return undefined;
        throw infrastructure('Python execution service failed', error);
      }).finally(async () => {
        await context.services.sandbox.run({ command: dockerCommand(), args: ['rm', '-f', container] }).catch(() => {});
      });
      // An unavailable execution service invalidates the attempt. A syntax or
      // runtime error in generated code remains an observation for the workflow.
      if (result && (!result.stdout.startsWith(started) || [125, 126, 127].includes(result.exitCode)))
        throw infrastructure(`Python container did not start: ${result.stderr.slice(-1000)}`);
      if (!result || [124, 137, 143].includes(result.exitCode)) return { status: 'failed', content: 'Python sandbox timed out or was killed. Diagnose termination and change the computation before retrying; an unchanged retry cannot make progress.',
        error: { code: 'PYTHON_TIMEOUT', message: 'Python execution timed out' } };
      return result.exitCode === 0 ? { status: 'success', content: result.stdout.slice(started.length) } :
        { status: 'failed', content: result.stderr, error: { code: 'PYTHON_EXECUTION', message: `Python exited ${result.exitCode}` } };
    },
  };
}
