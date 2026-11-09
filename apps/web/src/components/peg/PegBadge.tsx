"use client";

import { AppLink } from "@/components/shell/AppLink";
import { Pill } from "@/components/ui/Bits";
import { formatPegUsd } from "@/lib/format";
import { isV2, usePeg } from "@/lib/queries";
import { useReady } from "@/lib/env";

import styles from "./Peg.module.css";

/**
 * The MUSD peg in one pill, linking to the peg page: the median and whether new loans are open. Renders nothing on
 * a v1 deployment, which has no peg check.
 */
export function PegBadge({ linked = true }: { linked?: boolean }) {
  const env = useReady();
  const peg = usePeg();
  if (!isV2(env)) return null;

  let pill;
  let text: string;
  if (peg.error) {
    text = "MUSD peg could not be read";
    pill = <Pill tone="warning">{text}</Pill>;
  } else if (!peg.data) {
    text = "Reading the MUSD peg";
    pill = <Pill tone="outline">MUSD peg…</Pill>;
  } else if (peg.data.healthyOnChain) {
    text = `MUSD at ${formatPegUsd(peg.data.medianWad)}: peg healthy, new loans open`;
    pill = (
      <Pill tone="positive" dot>
        MUSD <span className="num">{formatPegUsd(peg.data.medianWad)}</span> · peg healthy
      </Pill>
    );
  } else {
    text = `MUSD at ${formatPegUsd(peg.data.medianWad)}: off peg, new loans paused`;
    pill = (
      <Pill tone="danger" dot>
        MUSD <span className="num">{formatPegUsd(peg.data.medianWad)}</span> · new loans paused
      </Pill>
    );
  }
  if (!linked) return <span title={text}>{pill}</span>;
  return (
    <AppLink href="/app/peg" className={styles.badgeLink} aria-label={`${text}. Open the MUSD peg page.`}>
      {pill}
    </AppLink>
  );
}
