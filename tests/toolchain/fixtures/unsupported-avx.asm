bits 64
global _start

section .rodata
value: dd 1.0

section .text
_start:
    vbroadcastss ymm0, [rel value]
    vzeroupper
    mov eax, 60
    xor edi, edi
    syscall
