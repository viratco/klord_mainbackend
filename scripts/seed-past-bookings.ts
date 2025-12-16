import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Starting to seed past bookings...');

    // Get existing customers
    const customers = await prisma.customer.findMany({
        take: 10
    });

    if (customers.length === 0) {
        console.log('No customers found. Please create customers first.');
        return;
    }

    const projectTypes = ['Residential', 'Commercial', 'Industrial', 'Ground Mounted'];
    const today = new Date();

    // Create bookings for each of the past 12 months
    const bookingsToCreate = [];

    for (let monthsAgo = 0; monthsAgo < 12; monthsAgo++) {
        // Create 2-4 bookings per month
        const bookingsThisMonth = Math.floor(Math.random() * 3) + 2;

        for (let i = 0; i < bookingsThisMonth; i++) {
            const bookingDate = new Date(today.getFullYear(), today.getMonth() - monthsAgo, Math.floor(Math.random() * 28) + 1);
            const customer = customers[Math.floor(Math.random() * customers.length)];
            const projectType = projectTypes[Math.floor(Math.random() * projectTypes.length)];

            // Random project value based on type
            const projectValues: any = {
                'Residential': Math.floor(Math.random() * 100000) + 100000,
                'Commercial': Math.floor(Math.random() * 300000) + 300000,
                'Industrial': Math.floor(Math.random() * 1000000) + 1000000,
                'Ground Mounted': Math.floor(Math.random() * 500000) + 500000
            };

            const sizedKW = Math.floor(Math.random() * 50) + 10;
            const monthlyBill = Math.floor(Math.random() * 5000) + 2000;

            bookingsToCreate.push({
                customerId: customer.id,
                projectType: projectType,
                sizedKW: sizedKW,
                monthlyBill: monthlyBill,
                estimateINR: projectValues[projectType],
                projectValue: projectValues[projectType],
                fullName: `Test Customer ${i}`,
                phone: `98${Math.floor(Math.random() * 100000000).toString().padStart(8, '0')}`,
                email: `test${i}@example.com`,
                address: `${Math.floor(Math.random() * 1000)} Test Street`,
                street: 'Test Street',
                city: 'Mumbai',
                state: 'Maharashtra',
                country: 'India',
                pincode: '400001',
                zip: '400001',
                withSubsidy: Math.random() > 0.5,
                createdAt: bookingDate,
                updatedAt: bookingDate
            });
        }
    }

    console.log(`Creating ${bookingsToCreate.length} bookings across 12 months...`);

    // Create all bookings
    for (const booking of bookingsToCreate) {
        const { customerId, ...bookingData } = booking;
        await prisma.booking.create({
            data: {
                ...bookingData,
                customer: {
                    connect: { id: customerId }
                }
            }
        });
    }

    console.log('✅ Successfully seeded past bookings!');
    console.log(`Total bookings created: ${bookingsToCreate.length}`);

    // Show distribution by month
    const monthCounts: any = {};
    bookingsToCreate.forEach(b => {
        const monthKey = b.createdAt.toLocaleString('default', { month: 'short', year: 'numeric' });
        monthCounts[monthKey] = (monthCounts[monthKey] || 0) + 1;
    });

    console.log('\nBookings by month:');
    Object.entries(monthCounts).forEach(([month, count]) => {
        console.log(`  ${month}: ${count} bookings`);
    });
}

main()
    .catch((e) => {
        console.error('Error seeding data:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
