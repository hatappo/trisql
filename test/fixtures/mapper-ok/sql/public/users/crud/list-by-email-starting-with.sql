SELECT * FROM users
WHERE email LIKE /*$email*/'sample%' ESCAPE '\'
ORDER BY email
LIMIT /*$limit*/100
