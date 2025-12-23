import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function mergeDuplicates() {
    console.log('🔍 Finding all customers...');
    const allCustomers = await prisma.customer.findMany();

    // Group by normalized phone (last 10 digits)
    const groups = new Map<string, any[]>();

    for (const c of allCustomers) {
        const normalized = c.mobile.replace(/\D/g, '').slice(-10);
        if (!groups.has(normalized)) {
            groups.set(normalized, []);
        }
        groups.get(normalized)!.push(c);
    }

    console.log(`Found ${groups.size} unique phone numbers`);

    for (const [phone, accounts] of groups.entries()) {
        if (accounts.length <= 1) continue;

        console.log(`\n📞 Processing ${phone} - found ${accounts.length} duplicates`);

        // Find the account with leads (priority: shortest mobile = legacy 10-digit)
        accounts.sort((a, b) => a.mobile.length - b.mobile.length);

        let primary = accounts[0];

        // Check which one has leads
        for (const acc of accounts) {
            const leadCount = await (prisma as any).booking.count({ where: { customerId: acc.id } });
            console.log(`  Account ${acc.id} (${acc.mobile}): ${leadCount} leads`);
            if (leadCount > 0) {
                primary = acc; // Prioritize account with data
            }
        }

        console.log(`  ✅ Primary account: ${primary.id} (${primary.mobile})`);

        // Rename duplicates
        for (const dup of accounts) {
            if (dup.id === primary.id) continue;

            console.log(`  🗑️ Renaming duplicate ${dup.id}...`);
            await prisma.customer.update({
                where: { id: dup.id },
                data: { mobile: `MERGED_${Date.now()}_${dup.mobile}` }
            });
        }

        // Upgrade primary to standard format (91XXXXXXXXXX)
        const standardFormat = '91' + phone;
        if (primary.mobile !== standardFormat) {
            console.log(`  🔄 Updating primary to ${standardFormat}`);
            await prisma.customer.update({
                where: { id: primary.id },
                data: { mobile: standardFormat }
            });
        }
    }

    console.log('\n✅ Merge complete!');
    await prisma.$disconnect();
}

mergeDuplicates().catch(console.error);
