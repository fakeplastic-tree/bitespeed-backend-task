import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { PrismaClient} from '@prisma/client';
import type { Contact } from './generated/prisma';

const app = express();
const prisma = new PrismaClient();

app.use(bodyParser.json());

type IdentifyRequest = {
  email?: string;
  phoneNumber?: string;
};

type IdentifyResponse = {
  contact: {
    primaryContactId: number;
    emails: string[];
    phoneNumbers: string[];
    secondaryContactIds: number[];
  };
};

app.post(
  '/identify',
  async (
    req: Request<{}, {}, IdentifyRequest>,
    res: Response<IdentifyResponse | { error: string }>
  ) => {
    const { email, phoneNumber } = req.body;

    try {
      if (!email && !phoneNumber) {
        return res
          .status(400)
          .json({ error: 'Either email or phoneNumber must be provided.' });
      }

      // Find all contacts that match either the email or phoneNumber
      const contacts = await prisma.contact.findMany({
        where: {
          OR: [
            ...(email ? [{ email }] : []),
            ...(phoneNumber ? [{ phoneNumber }] : []),
          ],
        },
        orderBy: { createdAt: 'asc' },
      });

      // No matching contacts, create a new primary
      if (contacts.length === 0) {
        const newContact = await prisma.contact.create({
          data: {
            email,
            phoneNumber,
            linkPrecedence: 'primary',
          },
        });

        return res.status(200).json({
          contact: {
            primaryContactId: newContact.id,
            emails: newContact.email ? [newContact.email] : [],
            phoneNumbers: newContact.phoneNumber ? [newContact.phoneNumber] : [],
            secondaryContactIds: [],
          },
        });
      }

      // Identify the oldest primary contact
      let primary = contacts.find((c: Contact) => c.linkPrecedence === 'primary') ?? contacts[0];
      for (const c of contacts as Contact[]) {
        if (c.createdAt < primary.createdAt) {
            primary = c;
        }
    }

      // Get all contacts directly or indirectly related to this primary
      const relatedContacts = await prisma.contact.findMany({
        where: {
          OR: [
            { id: primary.id },
            { linkedId: primary.id },
            ...(primary.linkedId ? [{ linkedId: primary.linkedId }] : []),
          ],
        },
      });

      const emails = new Set<string>();
      const phoneNumbers = new Set<string>();
      const secondaryContactIds: number[] = [];

      for (const c of relatedContacts as Contact[]) {
        if (c.email) emails.add(c.email);
        if (c.phoneNumber) phoneNumbers.add(c.phoneNumber);
        if (c.linkPrecedence === 'secondary') secondaryContactIds.push(c.id);
      }

      const emailExists = email ? emails.has(email) : true;
      const phoneExists = phoneNumber ? phoneNumbers.has(phoneNumber) : true;

      let newSecondary: Contact | null = null;

      if (!emailExists || !phoneExists) {
        const alreadyExists = relatedContacts.some(
          (c: Contact) => c.email === email && c.phoneNumber === phoneNumber
        );

        if (!alreadyExists) {
          newSecondary = await prisma.contact.create({
            data: {
              email,
              phoneNumber,
              linkPrecedence: 'secondary',
              linkedId: primary.id,
            },
          });

          if (newSecondary) {
            if (newSecondary.email) emails.add(newSecondary.email);
            if (newSecondary.phoneNumber) phoneNumbers.add(newSecondary.phoneNumber);
            secondaryContactIds.push(newSecondary.id);
          }
        }
      }

      // Demote any older primaries incorrectly marked as primary
      await Promise.all(
        relatedContacts
          .filter((c: Contact) => c.linkPrecedence === 'primary' && c.id !== primary.id)
          .map((c: Contact) =>
            prisma.contact.update({
              where: { id: c.id },
              data: {
                linkPrecedence: 'secondary',
                linkedId: primary.id,
              },
            })
          )
      );

      return res.status(200).json({
        contact: {
          primaryContactId: primary.id,
          emails: [...emails],
          phoneNumbers: [...phoneNumbers],
          secondaryContactIds,
        },
      });
    } catch (error) {
      console.error('Error in /identify:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
