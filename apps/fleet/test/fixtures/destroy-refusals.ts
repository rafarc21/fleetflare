/**
 * #87 review: the Worker's real destroy 409 bodies, for bun-lane tests that
 * cannot import src/studio/destroy.ts (it pulls the Workers runtime). Built
 * from the same pure pieces; test/studio.destroy.test.ts pins each one equal
 * to destroy.ts's own builder, so they cannot drift. Never-synced studio.
 */
import { recycleCostLine, LIVENESS_RULE } from "../../src/studio/recycle-cost";

const PREFIX = "destroy refused: ";
const cost = recycleCostLine(null, new Date(0), "the next provision");

/** destroy.ts destroyRefusal: the 8s container probe got no answer. */
export function probeRefusal(id: string): string {
  return PREFIX +
    "the container did not answer an 8s probe, so session sync, rescue-push and " +
    `learning harvest cannot run. ${cost} ` +
    `Also lost: uncommitted and unpushed work inside the container. ${LIVENESS_RULE} ` +
    `To discard anyway, as a stated choice: fleet destroy ${id} --discard-unsynced`;
}

/** destroy.ts destroyRescueUnconfirmedRefusal (issue #62). */
export function rescueUnconfirmedRefusal(id: string, reason: string): string {
  return PREFIX +
    `rescue-push could not confirm this studio's work was saved before destroy (${reason}); ` +
    `unpushed work may be lost. ${cost} ` +
    `To discard anyway, as a stated choice: fleet destroy ${id} --discard-unsynced`;
}
