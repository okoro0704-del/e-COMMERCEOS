import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("ECommerceOS seed is applied during POST /internal/distributor/provision.");
  const tenants = await prisma.tenant.count();
  console.log(`Tenants in database: ${tenants}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
