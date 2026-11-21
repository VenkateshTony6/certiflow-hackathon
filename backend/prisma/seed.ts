import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

const users = [
  { name: "Anika", email: "anika@certiflow.test", role: UserRole.TRAINING_CENTER, district: "Pune" },
  { name: "Dev", email: "dev@certiflow.test", role: UserRole.DISTRICT_OFFICER, district: "Pune" },
  { name: "Meera", email: "meera@certiflow.test", role: UserRole.DISTRICT_OFFICER, district: "Pune" },
  { name: "Kabir", email: "kabir@certiflow.test", role: UserRole.DISTRICT_OFFICER, district: "Mumbai" },
  { name: "Neha", email: "neha@certiflow.test", role: UserRole.QUALITY_TEAM, district: null },
  { name: "Farah", email: "farah@certiflow.test", role: UserRole.STATE_OFFICE, district: null },
];

async function main(): Promise<void> {
  const seededUsers = await Promise.all(
    users.map((user) =>
      prisma.user.upsert({
        where: { email: user.email },
        update: user,
        create: user,
      }),
    ),
  );

  const anika = seededUsers.find((user) => user.name === "Anika");
  if (!anika) throw new Error("Anika seed user was not created");

  await prisma.batch.upsert({
    where: { batchCode: "PUNE-2026-001" },
    update: {
      centerId: anika.id,
      district: "Pune",
      courseName: "Digital Skills Foundation",
      status: "SUBMITTED",
    },
    create: {
      batchCode: "PUNE-2026-001",
      centerId: anika.id,
      district: "Pune",
      courseName: "Digital Skills Foundation",
      status: "SUBMITTED",
    },
  });
}

main()
  .then(() => console.log("Database seed complete."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
