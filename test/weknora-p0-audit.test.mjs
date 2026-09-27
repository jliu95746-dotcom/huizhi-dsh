import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateSnapshot } from '../scripts/weknora-p0-audit.mjs'

const lock = {
  upstream: {
    commit: '3e8b0bfc80b845b2d4b2ed683994748741450a97',
    goVersion: '1.26.0',
    latestMigration: '000110',
    requiredPaths: ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'docker-compose.yml'],
    composeImages: {
      app: 'wechatopenai/weknora-app:${WEKNORA_VERSION:-latest}',
      postgres: 'paradedb/paradedb:v0.22.6-pg17',
    },
    imageDigests: {
      app: `sha256:${'a'.repeat(64)}`,
      postgres: `sha256:${'b'.repeat(64)}`,
    },
  },
}

function snapshot(overrides = {}) {
  return {
    commit: lock.upstream.commit,
    dirty: false,
    goMod: 'module github.com/Tencent/WeKnora\n\ngo 1.26.0\n',
    license: 'This project is licensed under the MIT License except for the third-party components listed below',
    paths: lock.upstream.requiredPaths,
    migrations: ['000109_previous.up.sql', '000110_current.up.sql'],
    composeImages: lock.upstream.composeImages,
    ...overrides,
  }
}

test('固定源码与镜像 digest 清单通过检查，但上游浮动默认值仍会提醒', () => {
  const result = evaluateSnapshot(snapshot(), lock)
  assert.equal(result.sourceVerified, true)
  assert.equal(result.imageDigestsRecorded, true)
  assert.deepEqual(result.failures, [])
  assert.ok(result.warnings.some((warning) => warning.code === 'floating_image_default'))
  assert.ok(!result.warnings.some((warning) => warning.code === 'image_digest_missing'))
})

test('缺少部署镜像 digest 时不能宣称镜像已经固定', () => {
  const partialLock = structuredClone(lock)
  delete partialLock.upstream.imageDigests.app
  const result = evaluateSnapshot(snapshot(), partialLock)
  assert.equal(result.sourceVerified, true)
  assert.equal(result.imageDigestsRecorded, false)
  assert.ok(result.warnings.some((warning) => warning.code === 'image_digest_missing'))
})

test('commit 不匹配时拒绝将检出目录当作固定上游', () => {
  const result = evaluateSnapshot(snapshot({ commit: 'f'.repeat(40) }), lock)
  assert.equal(result.sourceVerified, false)
  assert.ok(result.failures.some((failure) => failure.code === 'commit_mismatch'))
})

test('固定 commit 的检出目录有本地修改时仍拒绝通过', () => {
  const result = evaluateSnapshot(snapshot({ dirty: true }), lock)
  assert.equal(result.sourceVerified, false)
  assert.ok(result.failures.some((failure) => failure.code === 'checkout_dirty'))
})

test('迁移或核心镜像发生漂移时拒绝固定基线', () => {
  const result = evaluateSnapshot(snapshot({
    migrations: ['000109_previous.up.sql'],
    composeImages: { ...lock.upstream.composeImages, postgres: 'postgres:latest' },
  }), lock)
  assert.equal(result.sourceVerified, false)
  assert.ok(result.failures.some((failure) => failure.code === 'migration_mismatch'))
  assert.ok(result.failures.some((failure) => failure.code === 'compose_image_mismatch'))
})

test('缺少许可证或必要源码路径时拒绝继续', () => {
  const result = evaluateSnapshot(snapshot({ license: '', paths: ['docker-compose.yml'] }), lock)
  assert.equal(result.sourceVerified, false)
  assert.ok(result.failures.some((failure) => failure.code === 'license_mismatch'))
  assert.ok(result.failures.some((failure) => failure.code === 'required_path_missing'))
})
