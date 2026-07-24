import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { User, UserRole } from "../models/index.js";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "techavo-secret-jwt-key-2026-xyz";

export const signup = async (request, reply) => {
  try {
    const { email, password, full_name } = request.body;

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      reply.status(400).send({ error: "User already exists" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      email,
      password: hashedPassword,
      full_name,
    });

    const userCount = await User.count();
    if (userCount === 1) {
      await UserRole.create({
        user_id: user.id,
        role: "super_admin",
      });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "24h" });

    reply.status(201).send({
      session: {
        access_token: token,
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
        },
      },
    });
  } catch (error) {
    console.error("Signup Error:", error);
    reply.status(500).send({ error: "Internal server error" });
  }
};

export const signin = async (request, reply) => {
  try {
    const { email, password } = request.body;

    const user = await User.findOne({ where: { email } });
    if (!user) {
      reply.status(400).send({ error: "Invalid login credentials" });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      reply.status(400).send({ error: "Invalid login credentials" });
      return;
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "24h" });

    await user.update({ last_login_at: new Date() });

    reply.status(200).send({
      session: {
        access_token: token,
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
        },
      },
    });
  } catch (error) {
    console.error("Signin Error:", error);
    reply.status(500).send({ error: "Internal server error" });
  }
};

export const getCurrentUser = async (request, reply) => {
  try {
    reply.status(200).send({
      user: {
        id: request.user.id,
        email: request.user.email,
        full_name: request.user.full_name,
      },
    });
  } catch (error) {
    reply.status(500).send({ error: "Internal server error" });
  }
};

export const changePassword = async (request, reply) => {
  try {
    const { password } = request.body;
    if (!password || password.length < 6) {
      reply.status(400).send({ error: "Password must be at least 6 characters long" });
      return;
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.update({ password: hashedPassword }, { where: { id: request.user.id } });
    reply.status(200).send({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Change Password Error:", error);
    reply.status(500).send({ error: "Internal server error" });
  }
};
