import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '..', '.env') });

const prisma = new PrismaClient();

async function checkStaff() {
    try {
        const allStaff = await prisma.staff.findMany({
            select: {
                id: true,
                email: true,
                name: true,
                passwordHash: true,
            }
        });

        console.log('\n=== All Staff Members ===');
        console.log('Total:', allStaff.length);

        allStaff.forEach((staff, index) => {
            console.log(`\n${index + 1}. ${staff.name}`);
            console.log(`   Email: ${staff.email}`);
            console.log(`   ID: ${staff.id}`);
            console.log(`   Password Hash: ${staff.passwordHash?.substring(0, 30)}...`);
        });

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

checkStaff();
