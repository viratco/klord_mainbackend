const { PrismaClient } = require('@prisma/client');
const { generateCertificatePDF } = require('./dist/services/certificateService.js');
const prisma = new PrismaClient();

(async () => {
    try {
        const lead = await prisma.booking.findUnique({ where: { id: 'cmj31nwd70001h8bwu3vju09j' } });
        const steps = await prisma.leadStep.findMany({ where: { leadId: 'cmj31nwd70001h8bwu3vju09j' }, orderBy: { order: 'asc' } });
        const nonCertSteps = steps.filter(s => s.name?.toLowerCase() !== 'certificate');
        const latestCompletedAt = nonCertSteps
            .map(s => s.completedAt ? new Date(s.completedAt) : null)
            .filter(d => !!d)
            .sort((a, b) => a.getTime() - b.getTime())
            .pop();
        const installDate = (latestCompletedAt || new Date()).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
        const location = [lead.city, lead.state, lead.country].filter(Boolean).join(', ');
        const certificateId = `${lead.id.slice(0, 6).toUpperCase()}-${Date.now().toString().slice(-6)}`;

        console.log('Generating certificate for Parmod...');
        console.log('Data:', { customerName: lead.fullName, sizedKW: lead.sizedKW, installDate, location });

        const { publicUrl } = await generateCertificatePDF({
            leadId: lead.id,
            customerName: lead.fullName,
            projectType: lead.projectType,
            sizedKW: lead.sizedKW,
            installDate,
            location,
            certificateId,
        });

        await prisma.booking.update({
            where: { id: lead.id },
            data: { certificateUrl: publicUrl, certificateGeneratedAt: new Date() },
        });

        console.log('✅ Certificate generated!');
        console.log('URL:', publicUrl);
        await prisma.$disconnect();
    } catch (error) {
        console.error('Error:', error);
        await prisma.$disconnect();
        process.exit(1);
    }
})();
