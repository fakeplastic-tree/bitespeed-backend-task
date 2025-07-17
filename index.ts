import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { PrismaClient, Contact } from './generated/prisma';

const app = express();
const prisma = new PrismaClient();

app.use(bodyParser.json());

type IdentifyRequest = {
  email?: string;
  phoneNumber?: string;
};

type IdentifyResponse = {
  contact: {
    primaryContatctId: number;
    emails: string[];
    phoneNumbers: string[];
    secondaryContactIds: number[];
  };
};

app.post('/identify', async (req: Request<{}, {}, IdentifyRequest>, res: Response<IdentifyResponse | { error: string }>) => {
  const { email, phoneNumber } = req.body;

  try {
    // basic validation
    if (!email && !phoneNumber) {
      return res.status(400).json({ error: 'Either email or phoneNumber must be provided.' });
    }

    // find all possibly matching contacts by phone/email
    const contacts = await prisma.contact.findMany({
      where: {
        OR: [
          email ? { email } : undefined,
          phoneNumber ? { phoneNumber } : undefined
        ].filter(Boolean) as any[]
      },
      orderBy: { createdAt: 'asc' }
    });

    // create new primary
    if (contacts.length === 0) {
      const newContact = await prisma.contact.create({
        data: {
          email,
          phoneNumber,
          linkPrecedence: 'primary',
        }
      });

      return res.status(200).json({
        contact: {
          primaryContatctId: newContact.id,
          emails: newContact.email ? [newContact.email] : [],
          phoneNumbers: newContact.phoneNumber ? [newContact.phoneNumber] : [],
          secondaryContactIds: []
        }
      });
    }

    // identify primary contact (oldest)
    let primary = contacts.find(c => c.linkPrecedence === 'primary') ?? contacts[0];
    for (const c of contacts) {
      if (c.createdAt < primary.createdAt) {
        primary = c;
      }
    }

    // gather all contacts related to primary
    const relatedContacts = await prisma.contact.findMany({
      where: {
        OR: [
          { id: primary.id },
          { linkedId: primary.id },
          { linkedId: primary.linkedId ?? undefined }
        ]
      }
    });

    // unique identifiers
    const emails = new Set<string>();
    const phoneNumbers = new Set<string>();
    const secondaryContactIds: number[] = [];

    relatedContacts.forEach(c => {
      if (c.email) emails.add(c.email);
      if (c.phoneNumber) phoneNumbers.add(c.phoneNumber);
      if (c.linkPrecedence === 'secondary') {
        secondaryContactIds.push(c.id);
      }
    });

    // Add current email/phone if not already present
    const emailExists = email && [...emails].includes(email);
    const phoneExists = phoneNumber && [...phoneNumbers].includes(phoneNumber);

    let newSecondary: Contact | null = null;

    if (!emailExists || !phoneExists) {
      //check if exact match exists
      const alreadyExists = relatedContacts.some(c =>
        c.email === email && c.phoneNumber === phoneNumber
      );

      if (!alreadyExists) {
        newSecondary = await prisma.contact.create({
          data: {
            email,
            phoneNumber,
            linkPrecedence: 'secondary',
            linkedId: primary.id
          }
        });

        if (newSecondary.email) emails.add(newSecondary.email);
        if (newSecondary.phoneNumber) phoneNumbers.add(newSecondary.phoneNumber);
        secondaryContactIds.push(newSecondary.id);
      }
    }

    // ensure all related contacts point to the correct (oldest) primary
    await Promise.all(
      relatedContacts
        .filter(c => c.linkPrecedence === 'primary' && c.id !== primary.id)
        .map(c =>
          prisma.contact.update({
            where: { id: c.id },
            data: {
              linkPrecedence: 'secondary',
              linkedId: primary.id
            }
          })
        )
    );

    return res.status(200).json({
      contact: {
        primaryContatctId: primary.id,
        emails: [primary.email, ...[...emails].filter(e => e !== primary.email)].filter(Boolean),
        phoneNumbers: [primary.phoneNumber, ...[...phoneNumbers].filter(p => p !== primary.phoneNumber)].filter(Boolean),
        secondaryContactIds
      }
    });

  } catch (error) {
    console.error('Error in /identify:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
