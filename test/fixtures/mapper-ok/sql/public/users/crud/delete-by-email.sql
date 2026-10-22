DELETE FROM users
WHERE email = /*$email*/'sample'
RETURNING *
