import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { runVisualConfig } from './helpers/visualConfig';

// v8 moved shared provider settings to `upstream.*` and the Codex multi-agent flag to
// `client.*`. The backend lets the canonical key win by presence, so edits must land there.
describe('v8 canonical config paths', () => {
  test('reads legacy OAuth-scoped values until the canonical key exists', () => {
    const legacy = runVisualConfig(
      'oauth:\n  providers:\n    codex:\n      response-steering: true\n      optimize-multi-agent-v2: true\n'
    );
    expect(legacy.visualValues.codexResponseSteering).toBe(true);
    expect(legacy.visualValues.codexOptimizeMultiAgentV2).toBe(true);

    const canonical = runVisualConfig(
      'oauth:\n  providers:\n    codex:\n      response-steering: true\nupstream:\n  codex:\n    response-steering: false\n'
    );
    expect(canonical.visualValues.codexResponseSteering).toBe(false);
  });

  test('writes edits to the canonical paths', () => {
    const yaml = 'oauth:\n  providers:\n    codex:\n      response-steering: true\n';
    const config = runVisualConfig(yaml, [
      {
        codexResponseSteering: false,
        codexOptimizeMultiAgentV2: true,
        codexEnableApplyPatch: true,
        claudeHeaderUserAgent: 'agent/1',
      },
    ]);
    const output = parseYaml(config.applyVisualChangesToYaml(yaml));
    expect(output.upstream.codex['response-steering']).toBe(false);
    expect(output.client.codex).toEqual({
      'optimize-multi-agent-v2': true,
      'enable-apply-patch': true,
    });
    expect(output.upstream.claude['header-defaults']['user-agent']).toBe('agent/1');
  });

  test('reads Claude header defaults from upstream, falling back per field to the OAuth path', () => {
    const config = runVisualConfig(
      'oauth:\n  providers:\n    claude:\n      header-defaults:\n        os: Linux\n        arch: x64\nupstream:\n  claude:\n    header-defaults:\n      os: MacOS\n'
    );
    expect(config.visualValues.claudeHeaderOs).toBe('MacOS');
    expect(config.visualValues.claudeHeaderArch).toBe('x64');
  });
});
