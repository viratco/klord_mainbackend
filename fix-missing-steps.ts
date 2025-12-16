import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '..', '.env') });

const prisma = new PrismaClient();

const DEFAULT_STEPS = [
    'Meeting',
    'Survey',
    'Structure Install',
    'Civil Work',
    'Wiring',
    'Panel Installation',
    'Net Metering',
    'Testing',
    'Full Plant Start',
    'Subsidy Process Request',
    'Subsidy Disbursement',
    'Certificate',
];

async function fixMissingSteps() {
    try {
        console.log('🔍 Finding bookings with missing steps...\n');

        // Get all bookings with their steps
        const bookings = await prisma.booking.findMany({
            include: {
                steps: {
                    orderBy: { order: 'asc' }
                }
            }
        });

        console.log(`Found ${bookings.length} total bookings\n`);

        let fixedCount = 0;

        for (const booking of bookings) {
            const existingSteps = booking.steps;
            const missingSteps: string[] = [];

            // Check which steps are missing
            DEFAULT_STEPS.forEach((stepName, index) => {
                const exists = existingSteps.some(s => s.order === index + 1);
                if (!exists) {
                    missingSteps.push(stepName);
                }
            });

            if (missingSteps.length > 0) {
                console.log(`📋 Booking: ${booking.fullName} (${booking.projectType})`);
                console.log(`   ID: ${booking.id}`);
                console.log(`   Has ${existingSteps.length}/12 steps`);
                console.log(`   Missing: ${missingSteps.join(', ')}`);

                // Create missing steps
                for (let i = 0; i < DEFAULT_STEPS.length; i++) {
                    const stepName = DEFAULT_STEPS[i];
                    const order = i + 1;

                    const exists = existingSteps.some(s => s.order === order);
                    if (!exists) {
                        await prisma.leadStep.create({
                            data: {
                                leadId: booking.id,
                                name: stepName,
                                order: order,
                                completed: false,
                            }
                        });
                    }
                }

                console.log(`   ✅ Added ${missingSteps.length} missing steps\n`);
                fixedCount++;
            }
        }

        if (fixedCount === 0) {
            console.log('✨ All bookings already have all 12 steps!');
        } else {
            console.log(`\n✅ Fixed ${fixedCount} booking(s) with missing steps`);
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

fixMissingSteps();
