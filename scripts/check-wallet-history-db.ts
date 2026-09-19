import "./preload-env";
import { getWalletHistoryIntegrityReport } from "@/lib/walletLedger/indexed/store/persistWalletHistory";

async function main() {
  const r = await getWalletHistoryIntegrityReport();
  console.log(JSON.stringify(r, null, 2));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
