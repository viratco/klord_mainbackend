import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from parent directory
dotenv.config({ path: path.join(process.cwd(), '..', '.env') });

const prisma = new PrismaClient();

async function main() {
  // Simple command-line argument parsing
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error('Usage: npx ts-node scripts/create-admin.ts <email> <name> <password>');
    process.exit(1);
  }

  const [email, name, password] = args;

  if (!email || !name || !password) {
    console.error('Error: Email, name, and password are required.');
    process.exit(1);
  }

  console.log(`Attempting to create admin: ${name} (${email})`);

  try {
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const admin = await prisma.admin.create({
      data: {
        email,
        name,
        passwordHash,
      },
    });

    console.log('\n✅ Admin created successfully!');
    console.log(admin);

  } catch (error: any) {
    if (error.code === 'P2002') {
      console.error(`\n❌ Error: An admin with the email "${email}" already exists.`);
    } else {
      console.error('\n❌ Failed to create admin:', error.message);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
