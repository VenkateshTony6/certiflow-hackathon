import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.organization.upsert({
    where: { slug: "certiflow-demo" },
    update: { name: "CertiFlow Demo Academy" },
    create: { name: "CertiFlow Demo Academy", slug: "certiflow-demo" },
  });
}

main()
  .then(() => console.log("Database seed complete."))
  .finally(async () => prisma.$disconnect());

