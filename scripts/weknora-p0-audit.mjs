import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

function issue(code, detail) {
  return { code, detail }
}

export function evaluateSnapshot(snapshot, lock) {
  const expected = lock.upstream
  const failures = []
  const warnings = []
  let imageDigestsRecorded = true

  if (snapshot.commit !== expected.commit) {
    failures.push(issue('commit_mismatch', `期望 ${expected.commit}，实际 ${snapshot.commit}`))
  }
  if (snapshot.dirty) {
    failures.push(issue('checkout_dirty', '上游检出目录包含本地修改或未跟踪文件'))
  }
  if (!new RegExp(`^go ${expected.goVersion.replaceAll('.', '\\.')}\\s*$`, 'm').test(snapshot.goMod)) {
    failures.push(issue('go_version_mismatch', `go.mod 未声明 go ${expected.goVersion}`))
  }
  if (!snapshot.license.includes('licensed under the MIT License')) {
    failures.push(issue('license_mismatch', 'LICENSE 未包含固定版本的 MIT 许可说明'))
  }
  for (const path of expected.requiredPaths) {
    if (!snapshot.paths.includes(path)) {
      failures.push(issue('required_path_missing', path))
    }
  }
  const latestMigration = snapshot.migrations
    .map((name) => /^([0-9]{6})_.*\.up\.sql$/.exec(name)?.[1])
    .filter(Boolean)
    .sort()
    .at(-1)
  if (latestMigration !== expected.latestMigration) {
    failures.push(issue('migration_mismatch', `期望 ${expected.latestMigration}，实际 ${latestMigration ?? '无'}`))
  }
  for (const [service, expectedImage] of Object.entries(expected.composeImages)) {
    const actualImage = snapshot.composeImages?.[service]
    if (actualImage !== expectedImage) {
      failures.push(issue('compose_image_mismatch', `${service}: 期望 ${expectedImage}，实际 ${actualImage ?? '无'}`))
      imageDigestsRecorded = false
    }
    if (actualImage?.includes(':-latest') || actualImage?.endsWith(':latest')) {
      warnings.push(issue('floating_image_default', `${service}: ${actualImage}`))
    }
    const digest = expected.imageDigests?.[service]
    if (!digest) {
      warnings.push(issue('image_digest_missing', service))
      imageDigestsRecorded = false
    } else if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      failures.push(issue('image_digest_invalid', service))
      imageDigestsRecorded = false
    }
  }
  return { sourceVerified: failures.length === 0, imageDigestsRecorded, failures, warnings }
}

export function readUpstreamSnapshot(checkoutDir, lock) {
  const requiredPaths = lock.upstream.requiredPaths
  const composePath = join(checkoutDir, 'docker-compose.yml')
  const compose = yaml.load(readFileSync(composePath, 'utf8'))
  const composeImages = Object.fromEntries(
    Object.entries(compose.services ?? {}).map(([name, service]) => [name, service?.image]),
  )
  return {
    commit: execFileSync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['-C', checkoutDir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim().length > 0,
    goMod: readFileSync(join(checkoutDir, 'go.mod'), 'utf8'),
    license: readFileSync(join(checkoutDir, 'LICENSE'), 'utf8'),
    paths: requiredPaths.filter((path) => existsSync(join(checkoutDir, path))),
    migrations: readdirSync(join(checkoutDir, 'migrations', 'versioned')),
    composeImages,
  }
}

function dockerStatus() {
  try {
    const version = execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    }).trim()
    return { available: true, version }
  } catch {
    return { available: false, reason: 'Docker Engine 未运行或不可访问' }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(join(projectRoot, 'config', 'weknora-upstream-source.lock.json'), 'utf8'))
  const checkoutDir = resolve(process.argv[2] ?? join(projectRoot, '.runtime', 'weknora-upstream-v0.8.2'))
  let source
  try {
    source = evaluateSnapshot(readUpstreamSnapshot(checkoutDir, lock), lock)
  } catch (error) {
    source = {
      sourceVerified: false,
      failures: [issue('checkout_unavailable', error.message)],
      warnings: [],
    }
  }
  process.stdout.write(`${JSON.stringify({
    stage: 'P0',
    source: { tag: lock.upstream.tag, commit: lock.upstream.commit, checkoutDir, ...source },
    runtime: { docker: dockerStatus(), originalFlow: 'not_tested_by_this_command' },
    evaluation: { quality: 'not_tested_by_this_command' },
  }, null, 2)}\n`)
  if (!source.sourceVerified) process.exitCode = 1
}
