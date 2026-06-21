/**
 * AI version stamp for this version directory. Each client/src/ai/vN/ folder is
 * an independent, co-equal snapshot of the bot's decision logic; this constant
 * names which one. v5 is the current latest — to evolve the AI, copy this folder
 * to a new vN+1/ rather than rewriting it in place.
 *
 * v5 launch (2026-06-21): copied verbatim from v4 (the live Zoner backbone) and
 * evolved along a NEW, orthogonal axis the v4 ceiling analysis never explored —
 * DEFENSIVE escape-route robustness. v4's binding ceiling (v3:trapper) kills via
 * follow-up "vChain" sealing bombs, the SAME failure the user reports (v4 ducks
 * into dead-ends / stands in single-exit pockets and dies to one follow-up bomb).
 * v5 adds an anti-entrapment positional term + dead-end-averse refuge selection
 * so the bot keeps escape redundancy under foe pressure. Placed on the
 * Bradley-Terry ladder via `npm run bt-rank -- --target=v5:zoner` and gated head-
 * to-head against the live champion via `npm run v5-probe -- --target=v5:zoner`.
 */
export const AI_VERSION = 5;
