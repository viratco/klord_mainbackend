import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from parent directory
dotenv.config({ path: path.join(process.cwd(), '..', '.env') });

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Seeding AMC and Complaint requests...');

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
        console.log(`Customer ID: ${customer.id}`);

        // 2. Find or Create a Test Lead (Booking)
        const bookingCode = 'TEST-LEAD-001';
        let lead = await prisma.booking.findUnique({
            where: { bookingCode },
        });

        if (!lead) {
            console.log('Creating test lead...');
            lead = await prisma.booking.create({
                data: {
                    bookingCode,
                    customerId: customer.id,
                    projectType: 'Residential',
                    sizedKW: 5.5,
                    monthlyBill: 2500,
                    pincode: '110001',
                    estimateINR: 250000,
                    fullName: 'Test User',
                    phone: customerMobile,
                    address: '123 Test St',
                    street: 'Test Street',
                    city: 'Test City',
                    state: 'Test State',
                    country: 'India',
                    zip: '110001',
                    assigned: false,
                },
            });
        }
        console.log(`Lead ID: ${lead.id}`);

        // 3. Create AMC Requests
        console.log('Creating AMC requests...');
        await prisma.amcRequest.createMany({
            data: [
                {
                    leadId: lead.id,
                    customerId: customer.id,
                    status: 'pending',
                    note: 'Solar panels need cleaning due to dust accumulation.',
                },
                {
                    leadId: lead.id,
                    customerId: customer.id,
                    status: 'in_progress',
                    note: 'Inverter showing error code E04. Technician scheduled.',
                },
                {
                    leadId: lead.id,
                    customerId: customer.id,
                    status: 'resolved',
                    note: 'Regular annual maintenance check completed.',
                    resolvedAt: new Date(),
                },
            ],
        });

        // 4. Create Complaints
        console.log('Creating Complaints...');
        await prisma.complaint.createMany({
            data: [
                {
                    leadId: lead.id,
                    customerId: customer.id,
                    status: 'pending',
                    message: 'Installation team left debris in the backyard.',
                },
                {
                    leadId: lead.id,
                    customerId: customer.id,
                    status: 'in_progress',
                    message: 'App not showing generation data for the last 2 days.',
                },
                {
                    leadId: lead.id,
                    customerId: customer.id,
                    status: 'resolved',
                    message: 'Billing discrepancy in the last invoice.',
                },
            ],
        });

        console.log('✅ Seeding completed successfully!');

    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

main();
