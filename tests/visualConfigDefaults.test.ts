import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { getVisualConfigValidationErrors } from '@/hooks/useVisualConfig';
import { DEFAULT_VISUAL_VALUES } from '@/types/visualConfig';
import { runVisualConfig } from './helpers/visualConfig';

// Backend contract: config_load.go defaults WebsocketAuth to true; QuotaExceeded
// uses Go's false zero values. config.example.yaml values are not missing-key defaults.
describe('visual config boolean defaults', () => {
  test('initial and missing-key values agree with backend defaults', () => {
    for (const config of [runVisualConfig(), runVisualConfig('server:\n  port: 8317\n')]) {
      expect(config.visualValues.wsAuth).toBe(true);
      expect(config.visualValues.quotaSwitchProject).toBe(false);
      expect(config.visualValues.quotaSwitchPreviewModel).toBe(false);
      expect(config.visualDirty).toBe(false);
    }
  });

  for (const enabled of [true, false]) {
    test(`preserves explicit boolean values: ${enabled}`, () => {
      const yaml = `quota-exceeded:
  switch-project: ${enabled}
  switch-preview-model: ${enabled}
oauth:
  providers:
    aistudio:
      ws-auth: ${enabled}
`;
      const config = runVisualConfig(yaml);
      expect(config.visualValues.wsAuth).toBe(enabled);
      expect(config.visualValues.quotaSwitchProject).toBe(enabled);
      expect(config.visualValues.quotaSwitchPreviewModel).toBe(enabled);
      expect(parseYaml(config.applyVisualChangesToYaml(yaml))).toEqual(parseYaml(yaml));
    });
  }

  test('writes explicit false when disabling omitted ws-auth', () => {
    const yaml = 'server:\n  port: 8317\n';
    const config = runVisualConfig(yaml, [{ wsAuth: false }]);
    expect([...config.visualDirtyFields]).toEqual(['wsAuth']);
    expect(parseYaml(config.applyVisualChangesToYaml(yaml))).toEqual({
      server: { port: 8317 },
      oauth: { providers: { aistudio: { 'ws-auth': false } } },
    });
  });

  test('writes enabled quota options when their block was omitted', () => {
    const yaml = 'server:\n  port: 8317\n';
    const config = runVisualConfig(yaml, [
      { quotaSwitchProject: true, quotaSwitchPreviewModel: true },
    ]);
    expect(parseYaml(config.applyVisualChangesToYaml(yaml))).toEqual({
      server: { port: 8317 },
      'quota-exceeded': { 'switch-project': true, 'switch-preview-model': true },
    });
  });

  test('writes toggles in both directions without changing unrelated settings', () => {
    for (const enabled of [true, false]) {
      const yaml = `quota-exceeded:
  switch-project: ${!enabled}
  switch-preview-model: ${!enabled}
oauth:
  providers:
    aistudio:
      ws-auth: ${!enabled}
    antigravity:
      antigravity-credits: true
`;
      const config = runVisualConfig(yaml, [
        { wsAuth: enabled, quotaSwitchProject: enabled, quotaSwitchPreviewModel: enabled },
      ]);
      expect(parseYaml(config.applyVisualChangesToYaml(yaml))).toEqual({
        oauth: {
          providers: {
            aistudio: { 'ws-auth': enabled },
            antigravity: { 'antigravity-credits': true },
          },
        },
        'quota-exceeded': {
          'switch-project': enabled,
          'switch-preview-model': enabled,
        },
      });
    }
  });

  test('reverting toggles clears dirty state without inserting missing keys', () => {
    const yaml = 'server:\n  port: 8317\n';
    const config = runVisualConfig(yaml, [
      { wsAuth: false, quotaSwitchProject: true, quotaSwitchPreviewModel: true },
      { wsAuth: true, quotaSwitchProject: false, quotaSwitchPreviewModel: false },
    ]);
    expect(config.visualDirty).toBe(false);
    expect(config.visualDirtyFields.size).toBe(0);
    expect(config.applyVisualChangesToYaml(yaml)).toBe(yaml);
  });

  test('unrelated edits do not materialize boolean defaults', () => {
    const yaml = 'server:\n  port: 8317\n';
    const config = runVisualConfig(yaml, [{ debug: true }]);
    expect(parseYaml(config.applyVisualChangesToYaml(yaml))).toEqual({
      server: { port: 8317 },
      observability: { logs: { debug: true } },
    });
  });
});

describe('Codex usage-limit defaults', () => {
  test('missing keys read as off and do not materialize on unrelated edits', () => {
    const yaml = 'server:\n  port: 8317\n';
    const config = runVisualConfig(yaml, [{ debug: true }]);
    expect(config.visualValues.quotaCodexReservePercent).toBe('');
    expect(config.visualValues.quotaCodexDailyPacing).toBe(false);
    expect(parseYaml(config.applyVisualChangesToYaml(yaml))).not.toHaveProperty('quota-exceeded');
  });

  test('round-trips explicit values', () => {
    const yaml = `quota-exceeded:
  switch-project: true
  codex-reserve-percent: 11.5
  codex-daily-pacing: true
`;
    const config = runVisualConfig(yaml);
    expect(config.visualValues.quotaCodexReservePercent).toBe('11.5');
    expect(config.visualValues.quotaCodexDailyPacing).toBe(true);
    expect(parseYaml(config.applyVisualChangesToYaml(yaml))).toEqual(parseYaml(yaml));
  });

  test('writes numbers, and clearing the reserve removes the key', () => {
    const yaml = 'quota-exceeded:\n  codex-reserve-percent: 5\n';
    const set = runVisualConfig(yaml, [
      { quotaCodexReservePercent: '12', quotaCodexDailyPacing: true },
    ]);
    expect(parseYaml(set.applyVisualChangesToYaml(yaml))).toEqual({
      'quota-exceeded': { 'codex-reserve-percent': 12, 'codex-daily-pacing': true },
    });

    const cleared = runVisualConfig(yaml, [{ quotaCodexReservePercent: '' }]);
    expect(parseYaml(cleared.applyVisualChangesToYaml(yaml))).toEqual({});
  });

  test('validates the reserve as a 0-100 percentage', () => {
    const errorFor = (quotaCodexReservePercent: string) =>
      getVisualConfigValidationErrors({ ...DEFAULT_VISUAL_VALUES, quotaCodexReservePercent })
        .quotaCodexReservePercent;
    for (const valid of ['', '0', '11.5', '100']) expect(errorFor(valid)).toBeUndefined();
    for (const invalid of ['-1', '101', 'abc', '1e2']) {
      expect(errorFor(invalid)).toBe('percent_range');
    }
  });
});
