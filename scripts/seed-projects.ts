import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from parent directory
dotenv.config({ path: path.join(process.cwd(), '..', '.env') });

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Seeding Project Distribution Data...');

    try {
        // 1. Find or Create a Test Customer
        const customerMobile = '9999999999';
        let customer = await prisma.customer.findUnique({
            where: { mobile: customerMobile },
        });

        if (!customer) {
            console.log('Creating test customer...');
            customer = await prisma.customer.create({
                data: {
                    mobile: customerMobile,
                },
            });
        }

        // 2. Create Projects with different types
        const projects = [
            { type: 'Residential', count: 5 },
            { type: 'Commercial', count: 3 },
            { type: 'Industrial', count: 2 }
        ];

        for (const p of projects) {
            console.log(`Creating ${p.count} ${p.type} projects...`);
            for (let i = 0; i < p.count; i++) {
                const code = `PROJ-${p.type.substring(0, 3).toUpperCase()}-${Date.now()}-${i}`;
                await prisma.booking.create({
                    data: {
                        bookingCode: code,
                        customerId: customer.id,
                        projectType: p.type,
                        sizedKW: 5 + i,
                        monthlyBill: 2000 + (i * 100),
                        pincode: '110001',
                        estimateINR: 200000 + (i * 10000),
                        fullName: `Test ${p.type} Client ${i + 1}`,
                        phone: customerMobile,
                        address: `${i + 1} ${p.type} Street`,
                        street: 'Test Street',
                        city: 'Test City',
                        state: 'Test State',
                        country: 'India',
                        zip: '110001',
                        assigned: false,
                    },
                });
            }
        }

        console.log('✅ Project seeding completed successfully!');

    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

main();
