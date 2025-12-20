import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const SES_REGION = process.env.AWS_REGION || "ap-south-1";

const ses = new SESClient({ region: SES_REGION });

export async function sendEmailOTP(toEmail: string, otp: string) {
    const params = {
        Source: "klordenergy@gmail.com", // Temporary verified sender
        Destination: {
            ToAddresses: [toEmail],
        },
        Message: {
            Body: {
                Html: {
                    Charset: "UTF-8",
                    Data: `
                        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                            <h2 style="color: #1c1c1e;">Security Verification</h2>
                            <p style="color: #666; font-size: 16px;">Use the following code to complete your Admin login:</p>
                            <div style="background: #f4f4f4; padding: 20px; text-align: center; border-radius: 8px;">
                                <h1 style="letter-spacing: 5px; color: #1c1c1e; margin: 0;">${otp}</h1>
                            </div>
                            <p style="color: #999; font-size: 13px; margin-top: 20px;">This code will expire in 10 minutes. If you did not request this code, please ignore this email.</p>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #999; font-size: 12px; text-align: center;">&copy; 2025 Klord Energy. All rights reserved.</p>
                        </div>
                    `,
                },
                Text: {
                    Charset: "UTF-8",
                    Data: `Your Admin Login OTP is: ${otp}. It expires in 10 minutes.`,
                },
            },
            Subject: {
                Charset: "UTF-8",
                Data: `Admin Verification Code: ${otp}`,
            },
        },
    };

    try {
        const command = new SendEmailCommand(params);
        await ses.send(command);
        console.log(`[email] OTP sent successfully to ${toEmail}`);
        return true;
    } catch (error) {
        console.error("[email] Failed to send OTP email:", error);
        throw error;
    }
}
