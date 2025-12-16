import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';

const prisma = new PrismaClient();

/**
 * Sync dueDays on server startup by calculating actual elapsed time
 * This catches up on missed cron increments if server was offline
 */
export async function syncDueDaysOnStartup() {
    console.log('[SYNC] Syncing dueDays based on actual elapsed time...');

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

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];

                // Skip completed steps
                if (step.completed) {
                    if (step.dueDays !== 0) {
                        await prisma.leadStep.update({
                            where: { id: step.id },
                            data: { dueDays: 0 }
                        });
                        updatedCount++;
                    }
                    continue;
                }

                // Find when this step should have started
                let startDate: Date | null = null;

                if (i === 0) {
                    // First step starts when booking was created
                    startDate = booking.createdAt;
                } else {
                    // Step starts when previous step was completed
                    const prevStep = steps[i - 1];
                    if (prevStep.completed && prevStep.completedAt) {
                        startDate = prevStep.completedAt;
                    }
                }

                // Calculate dueDays based on elapsed time
                let correctDueDays = 0;

                if (startDate) {
                    const now = new Date();
                    const daysSinceStart = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

                    // dueDays should be at least 1 if step has started, capped at 5
                    correctDueDays = Math.max(1, Math.min(daysSinceStart + 1, 5));
                }

                // Update if different from current value
                if (step.dueDays !== correctDueDays) {
                    await prisma.leadStep.update({
                        where: { id: step.id },
                        data: { dueDays: correctDueDays }
                    });
                    updatedCount++;
                }
            }
        }

        console.log(`[SYNC] ✅ Synced ${updatedCount} steps to correct dueDays values`);
    } catch (error) {
        console.error('[SYNC] ❌ Error syncing dueDays:', error);
    }
}

/**
 * Daily cron job to increment dueDays for active incomplete steps
 * Runs every day at midnight (00:00)
 */
export function startDueDaysCron() {
    // Run daily at midnight
    cron.schedule('0 0 * * *', async () => {
        console.log('[CRON] Running daily dueDays update...');

        try {
            // Find all incomplete steps that are "active" (dueDays > 0)
            const activeSteps = await prisma.leadStep.findMany({
                where: {
                    completed: false,
                    dueDays: { gt: 0 }
                }
            });

            let updatedCount = 0;

            for (const step of activeSteps) {
                const newDueDays = Math.min(step.dueDays + 1, 5); // Cap at 5

                await prisma.leadStep.update({
                    where: { id: step.id },
                    data: { dueDays: newDueDays }
                });

                updatedCount++;
            }

            console.log(`[CRON] ✅ Updated ${updatedCount} steps (incremented dueDays)`);
        } catch (error) {
            console.error('[CRON] ❌ Error updating dueDays:', error);
        }
    });

    console.log('[CRON] ✅ Daily dueDays cron job scheduled (runs at midnight)');
}
