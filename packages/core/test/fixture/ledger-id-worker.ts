import * as Ledger from "../../src/deepagent/context/ledger"

const ledger = Ledger.applyUpdate(
  Ledger.emptyLedger("restart-probe", 1),
  { append: [{ kind: "goal", text: "probe" }] },
  1_000,
)

process.stdout.write(ledger.entries[0]!.id)
