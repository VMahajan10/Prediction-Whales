import "./preload-env";
import { countWalletLedgerEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import { persistIndexedWalletAudit } from "@/lib/walletLedger/indexed/store/persistWalletHistory";

const wallet = "0x1ff3d3fdef2558f3eb4aabdd7011a0245df8eb39";

async function main() {
  const before = await countWalletLedgerEvents(wallet);
  const audit = await runIndexedWalletAudit({
    label: "idempotency",
    wallet,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
  });
  await persistIndexedWalletAudit(audit);
  const after = await countWalletLedgerEvents(wallet);
  console.log(JSON.stringify({ before, after, delta: after - before }));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
