import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Seeding project stages...');

    // 1. Find or create a dummy customer
    let customer = await prisma.customer.findFirst({
        where: { mobile: '9999999999' }
    });

    if (!customer) {
        customer = await prisma.customer.create({
            data: {
                mobile: '9999999999',
                referralCode: 'TEST001'
            }
        });
        console.log('Created test customer');
    }

    // 2. Create a dummy booking (Lead)
    const lead = await prisma.booking.create({
        data: {
            customerId: customer.id,
            projectType: 'Residential',
            sizedKW: 5.0,
            monthlyBill: 5000,
            pincode: '110001',
            estimateINR: 250000,
            fullName: 'Test User',
            phone: '9999999999',
            address: 'Test Address',
            street: 'Test Street',
            state: 'Delhi',
            city: 'New Delhi',
            country: 'India',
            zip: '110001',
            assigned: true
        }
    });
    console.log(`Created test lead: ${lead.id}`);

    // 3. Create LeadSteps with various statuses
    const steps = [
        { name: 'Site Survey', order: 1, completed: true, days: 2 },
        { name: 'Design & Engineering', order: 2, completed: true, days: 3 },
        { name: 'Material Procurement', order: 3, completed: true, days: 5 },
        { name: 'Installation', order: 4, completed: false, days: 0 },
        { name: 'Testing & Commissioning', order: 5, completed: false, days: 0 },
        { name: 'Net Metering', order: 6, completed: false, days: 0 },
        { name: 'Subsidy Processing', order: 7, completed: false, days: 0 },
        { name: 'Project Handover', order: 8, completed: false, days: 0 }
    ];

    for (const step of steps) {
        const completedAt = step.completed
            ? new Date(Date.now() - (1000 * 60 * 60 * 24 * (10 - step.days))) // Completed 'days' ago
            : null;

        const createdAt = new Date(Date.now() - (1000 * 60 * 60 * 24 * 15)); // Created 15 days ago

        await prisma.leadStep.create({
            data: {
                leadId: lead.id,
                name: step.name,
                order: step.order,
                completed: step.completed,
                completedAt: completedAt,
                createdAt: createdAt,
                completionNotes: step.completed ? 'Completed successfully' : null
            }
        });
    }

    // Create another lead with different progress
    const lead2 = await prisma.booking.create({
        data: {
            customerId: customer.id,
            projectType: 'Commercial',
            sizedKW: 10.0,
            monthlyBill: 15000,
            pincode: '110002',
            estimateINR: 500000,
            fullName: 'Test User 2',
            phone: '9999999998',
            address: 'Test Address 2',
            street: 'Test Street 2',
            state: 'Maharashtra',
            city: 'Mumbai',
            country: 'India',
            zip: '400001',
            assigned: true
        }
    });

    const steps2 = [
        { name: 'Site Survey', order: 1, completed: true, days: 1 },
        { name: 'Design & Engineering', order: 2, completed: true, days: 2 },
        { name: 'Material Procurement', order: 3, completed: false, days: 0 },
        { name: 'Installation', order: 4, completed: false, days: 0 },
        { name: 'Testing & Commissioning', order: 5, completed: false, days: 0 },
        { name: 'Net Metering', order: 6, completed: false, days: 0 },
        { name: 'Subsidy Processing', order: 7, completed: false, days: 0 },
        { name: 'Project Handover', order: 8, completed: false, days: 0 }
    ];

    for (const step of steps2) {
        const completedAt = step.completed
            ? new Date(Date.now() - (1000 * 60 * 60 * 24 * (5 - step.days)))
            : null;

        const createdAt = new Date(Date.now() - (1000 * 60 * 60 * 24 * 10));

        await prisma.leadStep.create({
            data: {
                leadId: lead2.id,
                name: step.name,
                order: step.order,
                completed: step.completed,
                completedAt: completedAt,
                createdAt: createdAt
            }
        });
    }

    console.log('✅ Seeding completed!');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
