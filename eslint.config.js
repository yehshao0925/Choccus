// ESLint flat config for the whole monorepo.
//
// The most important part of this file is the `client/src/sim/**` override:
// the simulation must stay deterministic and renderer/network-free so it can
// be replayed headless (lockstep). Pixi, net code, wall-clock time and
// floating-point math intrinsics are all banned inside sim/.
import tseslint from 'typescript-eslint';

const SIM_ISOLATION_MSG =
  'client/src/sim/** is pure deterministic logic: no Pixi, no render/, no net/.';
const SIM_DETERMINISM_MSG =
  'Non-deterministic / floating-point intrinsic is banned in client/src/sim/** (use integer millitiles + the seeded PRNG).';
const AI_DETERMINISM_MSG =
  'Non-deterministic / floating-point intrinsic is banned in client/src/ai/** (bots are drop-in lockstep players; use integer math + the threaded bot RNG).';

// The determinism intrinsic bans are shared by the sim and AI overrides. (The
// AI tree legitimately imports sim types + shared code, so it does NOT get the
// pixi/render/net isolation ban — only these.) Math.floor/min/max/round/imul
// stay allowed: they are deterministic and not listed here.
const determinismRules = (msg) => ({
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: msg },
    { object: 'Math', property: 'random', message: msg },
    { object: 'Math', property: 'sin', message: msg },
    { object: 'Math', property: 'cos', message: msg },
    { object: 'Math', property: 'sqrt', message: msg },
    { object: 'performance', property: 'now', message: msg },
  ],
  'no-restricted-globals': ['error', { name: 'performance', message: msg }],
});

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.venv/**'],
  },
  ...tseslint.configs.recommended,
  {
    // --- Sim isolation guardrail (deterministic lockstep core) ---
    files: ['client/src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pixi.js', 'pixi.js/*'],
              message: SIM_ISOLATION_MSG,
            },
            {
              group: ['**/render', '**/render/*', '**/render/**'],
              message: SIM_ISOLATION_MSG,
            },
            {
              group: ['**/net', '**/net/*', '**/net/**'],
              message: SIM_ISOLATION_MSG,
            },
          ],
        },
      ],
      ...determinismRules(SIM_DETERMINISM_MSG),
    },
  },
  {
    // --- AI determinism guardrail (bots are drop-in lockstep players) ---
    // ONLY the determinism intrinsic bans — NOT the sim's pixi/render/net
    // isolation ban, because the AI legitimately imports sim types + shared code.
    files: ['client/src/ai/**/*.ts'],
    rules: {
      ...determinismRules(AI_DETERMINISM_MSG),
    },
  },
);
