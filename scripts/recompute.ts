/**
 * Re-run the valuation, wealth and confidence models across the whole book.
 * Use after changing anything in src/lib/scoring/.
 *
 *   npm run recompute
 */
import "../src/lib/load-env";
import { prisma } from "../src/lib/db";
import { recomputeAll } from "../src/lib/scoring/recompute";

async function main() {
  const counts = await recomputeAll();
  console.log(`Revalued ${counts.companies} companies and rescored ${counts.prospects} prospects.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
