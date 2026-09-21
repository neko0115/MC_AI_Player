import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  formatWorkspaceLivePreflightFailure,
  runWorkspaceLive,
  validateWorkspaceLivePreflight,
  WorkspaceLivePreflightError
} from '../../scripts/start-workspace-live.js'

const ROUTING_CREDENTIAL =
  'ROUTING_CREDENTIAL_MUST_NOT_LEAK'
const BRIDGE_TOKEN =
  'BRIDGE_TOKEN_MUST_NOT_LEAK'
const MASTER_SECRET =
  'MASTER_SECRET_MUST_NOT_LEAK_0123456789'

function routingConfig(): unknown {
  return {
    version: 1,
    models: {
      routine: {
        name: 'gemini-routine',
        reservation: {
          inputTokenOverhead: 1,
          generationTokenAllowance: {
            low: 1
          }
        }
      },
      complex: {
        name: 'gemini-complex',
        reservation: {
          inputTokenOverhead: 1,
          generationTokenAllowance: {
            medium: 1,
            high: 1
          }
        }
      }
    },
    projects: [
      {
        projectKey: 'pool-a',
        apiKeyEnv:
          'MC_AI_KEY_PRIMARY',
        providerLimits: {
          routine: {
            rpm: 1,
            inputTpm: 1,
            rpd: 1
          },
          complex: {
            rpm: 1,
            inputTpm: 1,
            rpd: 1
          }
        },
        flashBudget: {
          requestLimit: 1,
          totalTokenLimit: 1,
          resetWindow:
            'america-los-angeles-day',
          source: 'operator_policy'
        }
      }
    ],
    manualAccess: {
      ownerUuid:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operatorAllowlistUuids: []
    }
  }
}

function liveEnvironment(
  overrides: Readonly<
    Record<string, string | undefined>
  > = {}
): Record<string, string | undefined> {
  return {
    MC_HOST: '127.0.0.1',
    MC_PORT: '25565',
    MC_USERNAME: 'Moxue_Test',
    MC_AUTH: 'microsoft',
    MC_AI_PROVIDER: 'gemini',
    MC_AI_ROUTING_CONFIG:
      'ai-routing.json',
    MC_SERVER_IDENTITY_MODE:
      'online',
    MC_MOXUEBRIDGE_BASE_URL:
      'http://127.0.0.1:8766',
    MC_MOXUEBRIDGE_TOKEN:
      BRIDGE_TOKEN,
    MC_AI_KEY_PRIMARY:
      ROUTING_CREDENTIAL,
    ...overrides
  }
}

function withRoutingConfig(
  run: (directory: string) => void
): void {
  const directory =
    mkdtempSync(
      join(
        tmpdir(),
        'workspace-live-start-'
      )
    )
  try {
    writeFileSync(
      join(
        directory,
        'ai-routing.json'
      ),
      JSON.stringify(
        routingConfig()
      ),
      'utf8'
    )
    run(directory)
  } finally {
    rmSync(
      directory,
      {
        recursive: true,
        force: true
      }
    )
  }
}

function assertPreflightCode(
  operation: () => unknown,
  code: string
): void {
  assert.throws(
    operation,
    error =>
      error instanceof
        WorkspaceLivePreflightError &&
      error.code === code
  )
}

test('workspace live preflight accepts only the trusted online Gemini stack and reports disabled semantic cache without secrets', () => {
  withRoutingConfig(directory => {
    const report =
      validateWorkspaceLivePreflight(
        liveEnvironment(),
        { cwd: directory }
      )

    assert.deepEqual(
      report,
      {
        kind: 'ready',
        checks: {
          aiProvider: 'gemini',
          serverIdentityMode:
            'online',
          minecraftAuth:
            'microsoft',
          moxueBridgeEnabled:
            true,
          routingConfigPresent:
            true,
          routingConfigValid:
            true
        },
        credentialEnvs: [
          {
            name:
              'MC_AI_KEY_PRIMARY',
            set: true
          }
        ],
        semanticCacheEnabled:
          false,
        warnings: [
          'semantic_cache_disabled'
        ]
      }
    )

    const output =
      JSON.stringify(report)
    assert.equal(
      output.includes(
        ROUTING_CREDENTIAL
      ),
      false
    )
    assert.equal(
      output.includes(
        BRIDGE_TOKEN
      ),
      false
    )
  })
})

test('workspace live preflight requires Gemini online identity Microsoft auth and valid MoxueBridge configuration', () => {
  withRoutingConfig(directory => {
    for (const sample of [
      {
        env: liveEnvironment({
          MC_AI_PROVIDER: 'fake'
        }),
        code:
          'provider_not_gemini'
      },
      {
        env: liveEnvironment({
          MC_SERVER_IDENTITY_MODE:
            'offline'
        }),
        code:
          'identity_mode_not_online'
      },
      {
        env: liveEnvironment({
          MC_AUTH: 'offline'
        }),
        code:
          'minecraft_auth_not_microsoft'
      },
      {
        env: liveEnvironment({
          MC_MOXUEBRIDGE_BASE_URL:
            '',
          MC_MOXUEBRIDGE_TOKEN: ''
        }),
        code:
          'moxuebridge_not_enabled'
      },
      {
        env: liveEnvironment({
          MC_MOXUEBRIDGE_BASE_URL:
            'ftp://127.0.0.1',
        }),
        code:
          'moxuebridge_config_invalid'
      }
    ]) {
      assertPreflightCode(
        () =>
          validateWorkspaceLivePreflight(
            sample.env,
            { cwd: directory }
          ),
        sample.code
      )
    }
  })
})

test('workspace live preflight validates private routing JSON and reports credential names with booleans only', () => {
  withRoutingConfig(directory => {
    let error: unknown
    try {
      validateWorkspaceLivePreflight(
        liveEnvironment({
          MC_AI_KEY_PRIMARY: ''
        }),
        { cwd: directory }
      )
    } catch (caught) {
      error = caught
    }

    assert.ok(
      error instanceof
        WorkspaceLivePreflightError
    )
    assert.equal(
      error.code,
      'routing_credential_missing'
    )
    assert.deepEqual(
      formatWorkspaceLivePreflightFailure(
        error
      ),
      {
        kind: 'failed',
        code:
          'routing_credential_missing',
        credentialEnvs: [
          {
            name:
              'MC_AI_KEY_PRIMARY',
            set: false
          }
        ]
      }
    )
    assert.equal(
      JSON.stringify(
        formatWorkspaceLivePreflightFailure(
          error
        )
      ).includes(
        ROUTING_CREDENTIAL
      ),
      false
    )
  })

  const missingDirectory =
    mkdtempSync(
      join(
        tmpdir(),
        'workspace-live-missing-'
      )
    )
  try {
    assertPreflightCode(
      () =>
        validateWorkspaceLivePreflight(
          liveEnvironment(),
          {
            cwd:
              missingDirectory
          }
        ),
      'routing_config_missing'
    )
  } finally {
    rmSync(
      missingDirectory,
      {
        recursive: true,
        force: true
      }
    )
  }
})

test('workspace live preflight classifies an invalid Gemini routing path as routing configuration failure', () => {
  assertPreflightCode(
    () =>
      validateWorkspaceLivePreflight(
        liveEnvironment({
          MC_AI_ROUTING_CONFIG:
            'x'.repeat(4097)
        })
      ),
    'routing_config_invalid'
  )
})

test('workspace live preflight applies the existing 32 UTF-8 byte semantic master-secret boundary', () => {
  withRoutingConfig(directory => {
    assertPreflightCode(
      () =>
        validateWorkspaceLivePreflight(
          liveEnvironment({
            MC_WORKSPACE_SEMANTIC_MASTER_SECRET:
              'x'.repeat(31)
          }),
          { cwd: directory }
        ),
      'semantic_master_secret_invalid'
    )

    const report =
      validateWorkspaceLivePreflight(
        liveEnvironment({
          MC_WORKSPACE_SEMANTIC_MASTER_SECRET:
            'é'.repeat(16)
        }),
        { cwd: directory }
      )
    assert.equal(
      report.semanticCacheEnabled,
      true
    )
    assert.deepEqual(
      report.warnings,
      []
    )
  })
})

test('workspace live startup never constructs the application after a required preflight failure', async () => {
  let applicationStarts = 0
  const lines: string[] = []

  await assert.rejects(
    runWorkspaceLive(
      liveEnvironment({
        MC_AI_PROVIDER: 'fake'
      }),
      {
        cwd: process.cwd(),
        writeLine:
          line => lines.push(line),
        async startApplication() {
          applicationStarts += 1
        }
      }
    ),
    error =>
      error instanceof
        WorkspaceLivePreflightError &&
      error.code ===
        'provider_not_gemini'
  )

  assert.equal(
    applicationStarts,
    0
  )
  assert.deepEqual(
    lines,
    []
  )
})

test('workspace live startup prints only the sanitized ready report before constructing the application', async () => {
  await new Promise<void>((resolve, reject) => {
    withRoutingConfig(directory => {
      const lines: string[] = []
      let applicationStarts = 0

      void runWorkspaceLive(
        liveEnvironment({
          MC_WORKSPACE_SEMANTIC_MASTER_SECRET:
            MASTER_SECRET
        }),
        {
          cwd: directory,
          writeLine:
            line => lines.push(line),
          async startApplication() {
            applicationStarts += 1
          }
        }
      ).then(() => {
        try {
          assert.equal(
            applicationStarts,
            1
          )
          assert.equal(
            lines.length,
            1
          )
          const output =
            lines.join('\n')
          assert.equal(
            output.includes(
              ROUTING_CREDENTIAL
            ),
            false
          )
          assert.equal(
            output.includes(
              BRIDGE_TOKEN
            ),
            false
          )
          assert.equal(
            output.includes(
              MASTER_SECRET
            ),
            false
          )
          resolve()
        } catch (error) {
          reject(error)
        }
      }, reject)
    })
  })
})
