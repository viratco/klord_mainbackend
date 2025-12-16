import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function addTestBookings() {
    console.log('Adding test bookings for different project types...');

    const testBookings = [
        {
            projectType: 'Commercial',
            fullName: 'Test Commercial User',
            phone: '9876543210',
            email: 'commercial@test.com',
            address: 'Commercial Building',
            street: 'MG Road',
            state: 'Maharashtra',
            city: 'Mumbai',
            country: 'India',
            zip: '400001',
            sizedKW: 50.0,
            monthlyBill: 25000,
            pincode: '400001',
            estimateINR: 3000000,
        },
        {
            projectType: 'Industrial',
            fullName: 'Test Industrial User',
            phone: '9876543211',
            email: 'industrial@test.com',
            address: 'Industrial Estate',
            street: 'MIDC Area',
            state: 'Gujarat',
            city: 'Ahmedabad',
            country: 'India',
            zip: '380001',
            sizedKW: 100.0,
            monthlyBill: 50000,
            pincode: '380001',
            estimateINR: 6000000,
        },
        {
            projectType: 'Ground Mounted',
            fullName: 'Test Ground Mounted User',
            phone: '9876543212',
            email: 'ground@test.com',
            address: 'Farm Land',
            street: 'Village Road',
            state: 'Rajasthan',
            city: 'Jaipur',
            country: 'India',
            zip: '302001',
            sizedKW: 75.0,
            monthlyBill: 35000,
            pincode: '302001',
            estimateINR: 4500000,
        },
        {
            projectType: 'Commercial',
            fullName: 'Another Commercial User',
            phone: '9876543213',
            email: 'commercial2@test.com',
            address: 'Office Complex',
            street: 'Cyber City',
            state: 'Karnataka',
            city: 'Bangalore',
            country: 'India',
            zip: '560001',
            sizedKW: 60.0,
            monthlyBill: 30000,
            pincode: '560001',
            estimateINR: 3600000,
        },
        {
            projectType: 'Industrial',
            fullName: 'Another Industrial User',
            phone: '9876543214',
            email: 'industrial2@test.com',
            address: 'Manufacturing Unit',
            street: 'Industrial Area',
            state: 'Tamil Nadu',
            city: 'Chennai',
            country: 'India',
            zip: '600001',
            sizedKW: 120.0,
            monthlyBill: 60000,
            pincode: '600001',
            estimateINR: 7200000,
        },
    ];

    for (const booking of testBookings) {
        try {
            const created = await prisma.booking.create({
                data: booking,
            });
            console.log(`✅ Created ${booking.projectType} booking: ${created.id}`);
        } catch (error: any) {
            console.error(`❌ Failed to create ${booking.projectType} booking:`, error.message);
        }
    }

    console.log('\n✨ Test bookings added successfully!');
    await prisma.$disconnect();
}

addTestBookings().catch((error) => {
    console.error('Error:', error);
    process.exit(1);
});
