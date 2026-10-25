# Learned anatomy models

`scripts/train.ts` writes one statistical shape model per tooth class here
(`ssm-lowerMolar.json`, `ssm-upperPremolar.json`, …). Crown Studio loads the
model for the selected tooth automatically and shows “Anatomy: learned from N
cases”; without a model it uses the textbook template.

Models are learned from the lab's own finished crowns — they are lab data.
Commit them only if the repository is private to the lab.
