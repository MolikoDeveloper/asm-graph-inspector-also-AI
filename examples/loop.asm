bits 64

section .data
msg: db "hello", 10

section .text
global _start

_start:
    mov r12d, 5

.loop:
    mov eax, 1
    mov edi, 1
    mov rsi, msg
    mov edx, 6
    syscall

    dec r12d
    jne .loop

    mov eax, 60
    xor edi, edi
    syscall
