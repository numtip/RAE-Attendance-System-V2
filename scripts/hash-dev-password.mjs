#!/usr/bin/env node
/** Print bcrypt hash for dev password valid-pass (cost 8), same as fixtures.js */
import bcrypt from 'bcryptjs';

const hash = bcrypt.hashSync('valid-pass', 8);
console.log(hash);
