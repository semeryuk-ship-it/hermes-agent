/** Private SSH transport for the existing native owner. It never ensures/restarts an owner.
 * Not enabled in Desktop until the lifecycle and HTTP consumers are integrated. */
export interface NativeSshExec {
  exec(command: string, options: { timeoutMs: number; stdinData?: string; maxOutputBytes?: number }): Promise<string>
}

export interface NativeSshOwner {
  profile_id: string
  instance_id: string
  api_origin: string
  runtime_protocol: 1
}

export type NativeSshPurpose = 'interactive' | 'native-http'
const purposes = new Set<NativeSshPurpose>(['interactive', 'native-http'])
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const limit = 65_536

// This runs inside the installed runtime, reached through the existing SSH connection.
// Profile paths are resolved on the SERVER; Windows must not join Unix profile paths.
export const NATIVE_SSH_SCRIPT = `
import contextlib, io, json, re, sys
from pathlib import Path
from urllib.parse import urlsplit

def native_request(request):
    allowed = {'operation', 'profile', 'purpose', 'expected_instance'}
    if not isinstance(request, dict) or set(request) - allowed:
        return {'ok': False, 'reason': 'invalid_request'}
    name = request.get('profile', 'default')
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', name):
        return {'ok': False, 'reason': 'invalid_profile'}
    from hermes_cli.profiles import get_profile_dir
    from hermes_cli.gateway_runtime import discover_gateway_endpoint, attachable
    from hermes_cli.gateway_client import _session_ticket
    home = get_profile_dir(name).resolve(strict=True)
    found = discover_gateway_endpoint(home)
    if not attachable(found) or found.endpoint is None:
        return {'ok': False, 'reason': 'owner_not_ready'}
    owner = found.endpoint
    if owner.profile_id != str(home):
        return {'ok': False, 'reason': 'profile_mismatch'}
    url = urlsplit(owner.api_origin)
    if (owner.runtime_protocol != 1 or url.scheme != 'http' or
        url.hostname not in ('127.0.0.1', '::1') or not url.port or
        url.username or url.password or url.path not in ('', '/') or url.query or url.fragment):
        return {'ok': False, 'reason': 'invalid_owner'}
    endpoint = {key: getattr(owner, key) for key in ('profile_id', 'instance_id', 'api_origin', 'runtime_protocol')}
    if request.get('operation') == 'discover':
        return {'ok': True, 'endpoint': endpoint}
    if request.get('operation') != 'ticket' or request.get('purpose') not in ('interactive', 'native-http'):
        return {'ok': False, 'reason': 'invalid_request'}
    if request.get('expected_instance') != owner.instance_id:
        return {'ok': False, 'reason': 'owner_changed'}
    ticket = _session_ticket(home, owner, purpose=request['purpose'])
    return {'ok': True, 'endpoint': endpoint, 'ticket': ticket}

if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            answer = native_request(NATIVE_SSH_REQUEST)
    except Exception:
        answer = {'ok': False, 'reason': 'native_request_failed'}
    print(json.dumps(answer), flush=True)
`

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function owner(value: unknown): NativeSshOwner {
  if (!record(value) || typeof value.profile_id !== 'string' || !value.profile_id.startsWith('/') ||
      typeof value.instance_id !== 'string' || !value.instance_id || value.runtime_protocol !== 1 ||
      typeof value.api_origin !== 'string') {throw new Error('Invalid native SSH owner')}
  let url: URL
  try {url = new URL(value.api_origin)} catch {throw new Error('Invalid native SSH owner origin')}
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid native SSH owner origin')
  }
  return { profile_id: value.profile_id, instance_id: value.instance_id,
    api_origin: value.api_origin, runtime_protocol: 1 }
}

/** Private replies (especially tickets) must never become error diagnostics or persisted settings. */
export function createNativeSshOwnerClient(ssh: NativeSshExec, hermesLauncher: string) {
  if (!hermesLauncher.startsWith('/') || /[\r\n\0]/.test(hermesLauncher)) {throw new Error('Invalid remote Hermes launcher')}
  let bootstrap: string[] | undefined
  let closed = false
  let pending = 0
  let tail: Promise<void> = Promise.resolve()

  async function executeRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      if (closed) {throw new Error('Viewer closed')}
      if (!bootstrap) {
        const output = await ssh.exec(`${quote(hermesLauncher)} --print-runtime-command --module run_agent`, { timeoutMs: 15_000, maxOutputBytes: limit })
        if (output.length > limit) {throw new Error('Runtime response too large')}
        const argv: unknown = JSON.parse(output)
        if (!Array.isArray(argv) || argv.length < 3 || !argv.every(value => typeof value === 'string' && !value.includes('\0')) ||
            !argv[0].startsWith('/') || argv.at(-2) !== '-c') {throw new Error('Invalid installed runtime')}
        const marker = "runpy.run_module('run_agent'"
        const code = argv.at(-1) as string
        if (code.split(marker).length !== 2) {throw new Error('Unsupported installed bootstrap')}
        bootstrap = [...argv.slice(0, -1), code.split(marker)[0] + "exec(compile(sys.stdin.buffer.read(), '<desktop-native-ssh>', 'exec'))"]
      }
      // Request is data inside Python source via a JSON string literal, never shell interpolation.
      if (closed) {throw new Error('Viewer closed')}
      const script = 'NATIVE_SSH_REQUEST = __import__("json").loads(' + JSON.stringify(JSON.stringify(payload)) + ')\n' + NATIVE_SSH_SCRIPT
      const output = await ssh.exec(bootstrap.map(quote).join(' '), { timeoutMs: 15_000, stdinData: script, maxOutputBytes: limit })
      if (output.length > limit) {throw new Error('Native response too large')}
      const result: unknown = JSON.parse(output)
      if (!record(result) || result.ok !== true) {throw new Error('Native request refused')}
      return result
    } catch {
      // Never expose SSH output, server exceptions, request payloads or a partially received ticket.
      throw new Error('Could not use the existing native SSH owner; no fallback was attempted')
    }
  }

  // A fresh SSH connection per UI request otherwise trips sshd MaxStartups at boot.
  // Keep one control exchange in flight; never retry or change a refused request.
  function request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (closed || pending >= 64) {
      return Promise.reject(new Error('Native SSH control is closed or busy; no fallback was attempted'))
    }
    pending++
    const result = tail.then(() => executeRequest(payload))
    tail = result.then(() => { pending-- }, () => { pending-- })
    return result
  }

  return {
    close(): Promise<void> { closed = true; return tail },
    async discover(profile: string): Promise<NativeSshOwner> {
      return owner((await request({ operation: 'discover', profile })).endpoint)
    },
    async mint(profile: string, purpose: NativeSshPurpose, expected: NativeSshOwner): Promise<string> {
      if (!purposes.has(purpose)) {throw new Error('Unsupported native SSH ticket purpose')}
      const result = await request({ operation: 'ticket', profile, purpose, expected_instance: expected.instance_id })
      const actual = owner(result.endpoint)
      if (actual.instance_id !== expected.instance_id || actual.profile_id !== expected.profile_id || actual.api_origin !== expected.api_origin ||
          typeof result.ticket !== 'string' || !/^[A-Za-z0-9._~-]{1,16384}$/.test(result.ticket)) {
        throw new Error('Native SSH owner identity changed; reconnect explicitly')
      }
      return result.ticket
    }
  }
}
