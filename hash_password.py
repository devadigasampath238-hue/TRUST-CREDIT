"""
hash_password.py
--------------------------------------------------------------
Run this once to generate a secure hash of your admin password.
You'll paste the output into your ADMIN_PASSWORD_HASH environment
variable - the real password is never stored anywhere in plain text.

Usage:
    python hash_password.py
    (it will ask you to type a password, then print the hash)
"""

import getpass
from werkzeug.security import generate_password_hash

if __name__ == "__main__":
    password = input("Choose your new admin password: ")
    confirm = input("Type it again to confirm: ")

    if password != confirm:
        print("Passwords did not match. Please try again.")
    elif len(password) < 8:
        print("Please choose a password with at least 8 characters.")
    else:
        hashed = generate_password_hash(password)
        print("\nYour password hash (copy this entire line):\n")
        print(hashed)
        print("\nSet it as an environment variable like this:\n")
        print('  export ADMIN_PASSWORD_HASH="' + hashed + '"')
        print("\n(On Windows PowerShell: $env:ADMIN_PASSWORD_HASH=\"" + hashed + "\")")
