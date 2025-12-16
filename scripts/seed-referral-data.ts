import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function generateUniqueReferralCode(length = 8): Promise<string> {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    while (true) {
        let code = 'KLORD';
        for (let i = 0; i < length - 5; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const existing = await prisma.customer.findUnique({ where: { referralCode: code } });
        if (!existing) return code;
    }
}

async function seedReferralData() {
    console.log('🌱 Starting referral data seeding...');

    // First, ensure MLM settings exist
    const existingSettings = await prisma.mlSettings.findFirst();
    if (!existingSettings) {
        await prisma.mlSettings.create({
            data: {
                maxPayoutPercent: 4.0,
                level1Percent: 2.0,
                level2Percent: 1.0,
                level3Percent: 1.0
            }
        });
        console.log('✅ Created MLM settings');
    }

    // Create root users (level 0) - 3 root users
    const rootUsers = [];
    for (let i = 0; i < 3; i++) {
        const mobile = `+91 98765 ${String(10000 + i).padStart(5, '0')}`;
        const referralCode = await generateUniqueReferralCode();

        const customer = await prisma.customer.upsert({
            where: { mobile },
            update: {},
            create: {
                mobile,
                referralCode,
                level: 0
            }
        });
        rootUsers.push(customer);
        console.log(`✅ Created root user: ${mobile} (${referralCode})`);
    }

    // Create A1 users (direct referrals) - 5 per root user
    const a1Users = [];
    for (const root of rootUsers) {
        for (let i = 0; i < 5; i++) {
            const mobile = `+91 98765 ${String(20000 + rootUsers.indexOf(root) * 100 + i).padStart(5, '0')}`;
            const referralCode = await generateUniqueReferralCode();

            const customer = await prisma.customer.upsert({
                where: { mobile },
                update: {},
                create: {
                    mobile,
                    referralCode,
                    referredBy: root.id,
                    level: 1
                }
            });
            a1Users.push(customer);

            // Create wallet for A1 user
            await prisma.wallet.upsert({
                where: { customerId: customer.id },
                update: {},
                create: {
                    customerId: customer.id,
                    balance: Math.random() * 5000
                }
            });

            console.log(`  ✅ Created A1 user: ${mobile} under ${root.mobile}`);
        }
    }

    // Create A2 users (second level) - 3 per A1 user (for first 10 A1 users)
    const a2Users = [];
    for (let i = 0; i < Math.min(10, a1Users.length); i++) {
        const a1 = a1Users[i];
        for (let j = 0; j < 3; j++) {
            const mobile = `+91 98765 ${String(30000 + i * 10 + j).padStart(5, '0')}`;
            const referralCode = await generateUniqueReferralCode();

            const customer = await prisma.customer.upsert({
                where: { mobile },
                update: {},
                create: {
                    mobile,
                    referralCode,
                    referredBy: a1.id,
                    level: 2
                }
            });
            a2Users.push(customer);

            // Create wallet for A2 user
            await prisma.wallet.upsert({
                where: { customerId: customer.id },
                update: {},
                create: {
                    customerId: customer.id,
                    balance: Math.random() * 3000
                }
            });

            console.log(`    ✅ Created A2 user: ${mobile} under ${a1.mobile}`);
        }
    }

    // Create A3 users (third level) - 2 per A2 user (for first 15 A2 users)
    const a3Users = [];
    for (let i = 0; i < Math.min(15, a2Users.length); i++) {
        const a2 = a2Users[i];
        for (let j = 0; j < 2; j++) {
            const mobile = `+91 98765 ${String(40000 + i * 10 + j).padStart(5, '0')}`;
            const referralCode = await generateUniqueReferralCode();

            const customer = await prisma.customer.upsert({
                where: { mobile },
                update: {},
                create: {
                    mobile,
                    referralCode,
                    referredBy: a2.id,
                    level: 3
                }
            });
            a3Users.push(customer);

            // Create wallet for A3 user
            await prisma.wallet.upsert({
                where: { customerId: customer.id },
                update: {},
                create: {
                    customerId: customer.id,
                    balance: Math.random() * 2000
                }
            });

            console.log(`      ✅ Created A3 user: ${mobile} under ${a2.mobile}`);
        }
    }

    // Create sample commissions for root users
    console.log('\n💰 Creating sample commissions...');
    for (const root of rootUsers) {
        const rootA1s = a1Users.filter(a1 => a1.referredBy === root.id);

        for (const a1 of rootA1s) {
            // Commission from A1 (direct)
            const amount1 = Math.random() * 2000 + 500;
            await prisma.commission.create({
                data: {
                    customerId: root.id,
                    fromCustomerId: a1.id,
                    levelFromDownline: 1,
                    amount: amount1
                }
            });

            // Update root wallet
            await prisma.wallet.update({
                where: { customerId: root.id },
                data: { balance: { increment: amount1 } }
            });

            const a1A2s = a2Users.filter(a2 => a2.referredBy === a1.id);
            for (const a2 of a1A2s) {
                // Commission from A2 (indirect)
                const amount2 = Math.random() * 1000 + 200;
                await prisma.commission.create({
                    data: {
                        customerId: root.id,
                        fromCustomerId: a2.id,
                        levelFromDownline: 2,
                        amount: amount2
                    }
                });

                // Also give commission to A1
                const a1Amount = Math.random() * 1500 + 300;
                await prisma.commission.create({
                    data: {
                        customerId: a1.id,
                        fromCustomerId: a2.id,
                        levelFromDownline: 1,
                        amount: a1Amount
                    }
                });

                await prisma.wallet.update({
                    where: { customerId: root.id },
                    data: { balance: { increment: amount2 } }
                });

                await prisma.wallet.update({
                    where: { customerId: a1.id },
                    data: { balance: { increment: a1Amount } }
                });
            }
        }
    }

    console.log('\n✨ Referral data seeding completed!');
    console.log(`📊 Summary:`);
    console.log(`   - Root users (L0): ${rootUsers.length}`);
    console.log(`   - A1 users (L1): ${a1Users.length}`);
    console.log(`   - A2 users (L2): ${a2Users.length}`);
    console.log(`   - A3 users (L3): ${a3Users.length}`);
    console.log(`   - Total customers: ${rootUsers.length + a1Users.length + a2Users.length + a3Users.length}`);
}

seedReferralData()
    .catch((e) => {
        console.error('❌ Error seeding referral data:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
