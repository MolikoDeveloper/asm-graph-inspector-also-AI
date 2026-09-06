bits 64

section .data
msg: db "Hello World!\n"

section .text
global _start

_start:
    mov eax, 1
    mov edi, 1
    mov rsi, msg
    mov edx, 13
    syscall

    mov eax, 60
    xor edi, edi
    syscall
