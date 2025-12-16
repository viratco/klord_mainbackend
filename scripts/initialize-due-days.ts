import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function initializeDueDays() {
    console.log('Initializing dueDays for existing steps...');

    try {
        // Get all bookings with their steps
        const bookings = await prisma.booking.findMany({
            include: {
                steps: {
                    orderBy: { order: 'asc' }
                }
            }
        });

        let updatedCount = 0;

        for (const booking of bookings) {
            const steps = booking.steps;

            // Find the first incomplete step (this is the "active" one)
            const firstIncompleteIndex = steps.findIndex(s => !s.completed);

            if (firstIncompleteIndex === -1) {
                // All steps completed, set all to 0
                for (const step of steps) {
                    await prisma.leadStep.update({
                        where: { id: step.id },
                        data: { dueDays: 0 }
                    });
                }
                continue;
            }

            // Set completed steps to 0
            for (let i = 0; i < firstIncompleteIndex; i++) {
                await prisma.leadStep.update({
                    where: { id: steps[i].id },
                    data: { dueDays: 0 }
                });
            }

            // Calculate dueDays for the first incomplete step
            const activeStep = steps[firstIncompleteIndex];
            const startDate = firstIncompleteIndex === 0
                ? new Date(booking.createdAt)
                : steps[firstIncompleteIndex - 1].completedAt;

            if (startDate) {
                const now = new Date();
                const diffTime = now.getTime() - new Date(startDate).getTime();
                const daysElapsed = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                const dueDays = Math.min(Math.max(daysElapsed, 1), 5); // 1-5 range

                await prisma.leadStep.update({
                    where: { id: activeStep.id },
                    data: { dueDays }
                });
                updatedCount++;

                console.log(`Booking ${booking.id}: Set step "${activeStep.name}" to dueDays=${dueDays}`);
            }

            // Set future steps to 0
            for (let i = firstIncompleteIndex + 1; i < steps.length; i++) {
                await prisma.leadStep.update({
                    where: { id: steps[i].id },
                    data: { dueDays: 0 }
                });
            }
        }

        console.log(`✅ Successfully initialized dueDays for ${updatedCount} active steps`);
    } catch (error) {
        console.error('Error initializing dueDays:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

initializeDueDays()
    .then(() => {
        console.log('Done!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Failed:', error);
        process.exit(1);
    });
